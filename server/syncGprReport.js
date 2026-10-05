// Синхронизация процента готовности из графиков производства работ (ГПР) —
// нескольких источников сразу (см. SOURCES ниже). Логика разбора одного
// листа 1:1 повторяет исходный Python-парсер на ноутбуке (см. историю
// задачи "парсер ГПР поз.64.ipynb"), переписанный на Node и обобщённый на
// произвольное число листов после добавления второго источника (НЖ3).
//
// Формат исходника — общий шаблон компании, стабильный между листами по
// смыслу, но не по точному номеру строки/колонки (сколько строк-заголовков
// объекта идёт перед подписями колонок, растянуты ли недельные даты на одну
// строку или на несколько подряд — у листа "факт" (Нурлы Жол 4) 2025 год и
// 2026-2027 годы прописаны в двух РАЗНЫХ строках одна под другой, видимо
// из-за того что таблицу дописывали по частям). Поэтому строка подписей и
// строки с датами ищутся динамически, а не хардкодятся номером:
// - строка подписей — первая строка, где есть ячейка "Окончание" (по ней же
//   вычисляем колонку начала недельных дат, и "Конструктивы" — колонку
//   названия работы); ищем в первых LABELS_SEARCH_ROWS строках;
// - дальше подряд читаем строки и собираем из них ячейки-serial-даты
//   (число >= MIN_DATE_SERIAL — так отличаем реальную дату от, например,
//   доли 0..1 в строке-подытоге "Позиция N"), пока не упрёмся в границу
//   данных: либо колонка A уже содержит маркер 'поз.NN' (данные начались
//   без явной строки-подытога), либо колонка "Конструктивы" содержит
//   "Позиция ..." (итоговая сводка перед данными этой позиции).
// Колонка A содержит маркер 'поз.NN' у каждой строки данных этой позиции; у
// строк-разделов без данных (например, "Кровельные работы" на листе
// "64,72") колонка A ВСЁ РАВНО содержит маркер позиции — их приходится
// исключать по имени (source.excludeWorkNames), а не по пустой колонке A.
// У строк-заголовков "Позиция N" колонка A, наоборот, пустая — их отсеивает
// POSITION_MARKER_RE.
const cron = require('node-cron');
const { getWriteDb } = require('./db');
const { getUnformattedValues } = require('./googleSheetsClient');

const LABELS_SEARCH_ROWS = 10; // сколько первых строк листа проверяем в поисках подписи "Окончание"
const MIN_DATE_SERIAL = 40000; // Excel-serial дат начиная примерно с 2009 года
const MAX_DATE_SERIAL = 60000; // ...и примерно по 2064 год — обе границы просто отсекают заведомо не-даты
                                // (доли 0..1, суммы в тенге и т.п.), которые тоже могут быть числами
const DATA_RANGE = 'A1:JZ1500'; // с запасом и по строкам, и по колонкам (лист "брик таун 3" использует до ~216 колонок)

const POSITION_MARKER_RE = /^поз\.\d+/;
const STAGE_MARKER_RE = /^\d+\s*этап/i; // 'N этап' — верхний уровень группировки у sheet.stagedSections

const SOURCES = [
  {
    key: 'poz64_72',
    label: 'ГПР 64,72,59,63,65,69',
    // Два листа под одним источником — один и тот же ответственный
    // человек, тот же объект "Нурлы Жол 3", участок Макажанова, просто
    // разные подмножества позиций на разных листах ("64,72" и
    // "59,63,65,69"). Отдельно объединяли ещё и с "ГПР Экополис
    // поз.103,104,105" (ключ 'ekopolis2'), но разделили обратно — вместе
    // источник получался слишком широким, стало не разобрать по отчёту,
    // по какой именно позиции пропуск.
    sheets: [
      { spreadsheetId: '1eC80R11Hp26IVfLLa4M-_wnYGqTRHEi6k2_XG5Goqf0', sheetName: '64,72' },
      { spreadsheetId: '1EkK07BEs0kcK29Yc6z7j3KFX8i_04AFAKv91zbuZKK8', sheetName: '59,63,65,69' },
    ],
    // поз.64 и поз.72 — основные (не "коммерческие") блоки листа "64,72".
    // Есть ещё 'поз.64 ком.'/'поз.72 ком.' (отдельные строки-маркеры для
    // коммерческих помещений тех же позиций) — их намеренно не включаем,
    // не просили. поз.59,63,65,69 — с листа "59,63,65,69", там нет
    // "коммерческих" вариантов, включаем все.
    includePosition: (pos) =>
      ['поз.64', 'поз.72', 'поз.59', 'поз.63', 'поз.65', 'поз.69'].includes(pos),
    // Строки-разделы без данных на листе "64,72" (заголовок группы работ,
    // а не отдельная работа).
    excludeWorkNames: new Set(['Кровельные работы', 'Окна и витражи', 'ВК и ОВ']),
  },
  {
    key: 'nz3',
    label: 'ГПР НЖ3 (ОВ, ВК)',
    sheets: [{ spreadsheetId: '160_Nmmj4p0jX5NdJLTpRntoFHDHoxiyZptEVdp0U3mE', sheetName: 'НЖ3' }],
    // Вся вкладка целиком — любая позиция с маркером поз.NN (56, 72, 69, 64, 63, 59, 65).
    includePosition: () => true,
    // "Водоснабжение и канализация" и "Отопление" здесь — промежуточные
    // итоги (агрегат по своим же дочерним строкам: "Ливневая канализация"/
    // "Пожарный водопровод"/"Канализация"/"ХВС"/"ГВС" и "Отопление
    // (стояки)"/"...(разводка и радиаторы)"/"...(тепловой узел)"
    // соответственно) — НЕ отдельная работа, поэтому не пропуск, если
    // пусто. В листе "64,72" эти же названия — реальные конечные позиции,
    // их исключение отсюда не касается (разные source, разные списки).
    excludeWorkNames: new Set(['Водоснабжение и канализация', 'Отопление']),
  },
  {
    key: 'facades',
    label: 'Фасады',
    sheets: [{ spreadsheetId: '1WcB1F8B8vdth1DHwa6UkKSfMag1UmDzRWcuHik9kUEA', sheetName: 'план_processed' }],
    // Вся вкладка целиком — 5 объектов (Нурлы Жол 3, Спорт, Экополис, Лицей,
    // Ледовый каток), 16 позиций (56, 59, 63, 64, 65, 69, 72, 74, 76,
    // "73,75", 93, 100, 101, 103, 104, 105).
    includePosition: () => true,
    excludeWorkNames: new Set(),
    // У части позиций есть несколько блоков (например, поз.59 — 4 блока):
    // строка "Блок N" в колонке "Конструктивы" — промежуточный итог по
    // своим дочерним строкам (та же природа, что "Позиция N"/подытоги в
    // НЖ3), не отдельная работа. См. блок-трекинг в fetchAndParseSheet.
    blockMarkerRe: /^Блок\s+\d+/i,
  },
  {
    key: 'sport2',
    label: 'ГПР Спорт 2',
    sheets: [{ spreadsheetId: '1I1zCQjPKGjZmRp2yIr23shae6SXMV-I6YO-rDGzvBgA', sheetName: 'ГПР' }],
    // Вся вкладка целиком — 6 позиций (73,75, 74, 76, 93, 100, 101). У листа
    // есть доп. колонка "план/факт/прогноз" (B) и строки-материалы (тип
    // "Материал" в последней колонке) вперемешку со строками-работами —
    // но и у "Позиция N"-сводок, и у строк-материалов колонка A (позиция)
    // пустая, так что оба вида уже отсеиваются общей проверкой
    // POSITION_MARKER_RE, без доп. фильтров.
    includePosition: () => true,
    excludeWorkNames: new Set(),
  },
  {
    key: 'nz4',
    label: 'ГПР Нурлы Жол 4',
    sheets: [
      {
        spreadsheetId: '102E0nzIE4gyp_t4HNozvy4w-dZAa8rZ_oqx_L5IAPjQ',
        sheetName: 'факт',
        // 2025 год и 2026-2027 годы прописаны в двух строках подряд под
        // подписями (offset 1 и 2 от строки подписей), а не в одной, как у
        // остальных листов (offset 2 по умолчанию).
        dateRowOffsets: [1, 2],
      },
    ],
    // Плановые сроки — не колонки "Начало"/"Окончание" листа "факт", а
    // перепланировка (базовый план 2 на 05.10.2026), см. fetchPlanSheet.
    // При следующей перепланировке — поменять sheetName здесь.
    planSheet: {
      spreadsheetId: '102E0nzIE4gyp_t4HNozvy4w-dZAa8rZ_oqx_L5IAPjQ',
      sheetName: 'базовый план 2 (05.10.2026)',
    },
    // Вся вкладка целиком — 9 позиций (1.1..1.9). У листа есть колонка
    // "Категория" (последняя), размечающая каждую строку данных как
    // "Работа" (реальная работа, отслеживаем % готовности) или "Материал"
    // (расход материала, например "Арматура АI Ø6, тн" — число там не %
    // готовности, а доля/объём поставки) — и, в отличие от листа "ГПР
    // Спорт 2", строки-материалы здесь ИМЕЮТ маркер позиции в колонке A
    // (не отсеиваются пустой колонкой A), поэтому фильтруются явно по
    // "Категория" === "Материал" (см. fetchAndParseSheet).
    includePosition: () => true,
    excludeWorkNames: new Set(),
  },
  {
    key: 'nz5',
    label: 'ГПР Нурлы Жол 5 и Ледовый каток',
    // Два листа под одним источником — один и тот же ответственный человек,
    // но структурно разные таблицы: "план" — обычные позиции поз.4.X, а
    // "ГПР" (Каток) вообще без колонки "позиция" — см. sectionsArePositions.
    sheets: [
      {
        spreadsheetId: '1hbfMRSH7wsP5KhSDk5Tuk79pirvftOC_tFXHHWryPIg',
        sheetName: 'план',
        // 11 позиций (4.1..4.9, 4.11, и совмещённая "4.10-4.12"). Та же
        // "Категория" (Работа/Материал), что и у "ГПР Нурлы Жол 4". Все
        // недельные даты (2026-2027, с 2025 годом лист не начинается)
        // умещаются в одной строке — offset [2] по умолчанию.
      },
      {
        spreadsheetId: '17o-Sg8XtD6Fd46RlUOSo1ISFixM3yVtJ-YP-MAg_7Lo',
        sheetName: 'ГПР',
        // Колонки "позиция" нет вообще — весь объект ("Каток") описан
        // плоским списком работ без поз.NN, сгруппированным заголовками
        // разделов ("Административный блок", "Ледовый зал"): у этих строк
        // колонка A пустая, а название раздела — в колонке "Конструктивы"
        // (как "Позиция N" у обычных листов, только это единственный
        // уровень группировки, а не под-уровень внутри позиции). Поэтому
        // берём заголовок раздела как "позицию" вместо реального поз.NN
        // (см. sectionsArePositions в fetchAndParseSheet). Колонка A на
        // строках-данных всегда "план" (там нет "факт"/"прогноз" на этом
        // листе) — сама по себе не используется.
        sectionsArePositions: true,
      },
    ],
    includePosition: () => true,
    excludeWorkNames: new Set(),
  },
  {
    key: 'nz5_fact',
    label: 'ГПР Нурлы Жол 5 (факт, для финплана)',
    // Тот же spreadsheetId, что у 'nz5', НО лист "факт", а не "план" —
    // отдельный source, а не просто добавленный лист в 'nz5', потому что
    // 'nz5' используется ещё и для проверки пропусков отчётности на
    // /admin/users, и трогать его поведение не нужно. Разница между
    // листами: у "план" % каждого раздела плавно доходит до 100 ровно к
    // плановой дате окончания и дальше остаётся 100 (похоже на проекцию,
    // а не на реальные еженедельные отметки от людей на площадке); у
    // "факт" недельные значения — настоящие отчёты (см. историю задачи:
    // "Финплан объекта" показывал полосу факта 1:1 с планом для Нурлы Жол
    // 5, хотя по факту готовность значительно отставала). Структура листа
    // идентична "план" (те же колонки "Начало"/"Окончание"/"Категория",
    // недельные даты в одной строке — offset [2] по умолчанию).
    sheets: [
      { spreadsheetId: '1hbfMRSH7wsP5KhSDk5Tuk79pirvftOC_tFXHHWryPIg', sheetName: 'факт' },
    ],
    includePosition: () => true,
    excludeWorkNames: new Set(),
  },
  {
    key: 'razvyazka',
    label: 'ГПР Развязка',
    sheets: [
      {
        spreadsheetId: '16F_1zGQxSxNazg-Bp3mKlJHBn311S0TsUhwCuMxApoE',
        sheetName: 'ГПР факт',
        // Совсем другой шаблон (дорожная развязка, не здание): подпись
        // конечной даты — "Дата окончания", а не "Окончание" (см. общий
        // поиск по корню "оконч" в fetchAndParseSheet); колонки
        // "Конструктивы" нет вообще — название работы без подписи в
        // строке заголовков (соседняя "Объем работы" — это подпись для
        // КОЛИЧЕСТВА в следующей колонке, не имени работы), поэтому индекс
        // задан явно.
        workNameColIndex: 1,
        // Ни поз.NN, ни плоских разделов — двухуровневая структура "N
        // этап" (1 этап, "2 этап (путепроводы)", "3 этап (петля)") с
        // вложенными разделами ("Демонтажные работы", "Автомобильные
        // дороги" и т.п.), причём НАЗВАНИЯ разделов повторяются в разных
        // этапах — поэтому этап становится "позицией", а раздел —
        // "блоком" (см. stagedSections в fetchAndParseSheet).
        stagedSections: true,
      },
    ],
    includePosition: () => true,
    // "ИТОГО: %" — подытог по всему разделу "Система оперативно-
    // дистанционного контроля сетей теплоснабжения" (у него нет других
    // строк-работ вообще, только этот агрегат) — не отдельная работа.
    excludeWorkNames: new Set(['ИТОГО: %']),
  },
  {
    key: 'brick2',
    label: 'Brick Town 2',
    sheets: [
      {
        spreadsheetId: '1k7zGcNHeM1qXXNzEBO7NCNowSp_rd2oxxl0t86dElRY',
        sheetName: 'брик таун 2',
        // Позиции — "Пятно 1/2/3", "Гараж", "Подпорные стены" (никакого
        // поз.NN), поэтому POSITION_MARKER_RE не подходит — принимаем
        // любую непустую ячейку.
        positionMarkerRe: /^.+/,
        // Колонка A заполняется ТОЛЬКО на первой строке каждой группы
        // работ, дальше пустая до следующей группы — "липкая" позиция
        // (в отличие от поз.NN-листов, где A повторяется на каждой
        // строке). См. sheet.stickyPosition в fetchAndParseSheet: блок-
        // подытоги ("Пятно 3 3.1 блок") и "анонсы" следующей позиции без
        // блока ("Гараж"/"Подпорные стены" перед своей же строкой) — тоже
        // с пустой колонкой A, их приходится отличать от настоящих
        // строк-данных.
        stickyPosition: true,
      },
    ],
    includePosition: () => true,
    // "Пятно N X.Y блок" / "Пятно N Блок X.Y" — подытог блока (аналог
    // "Блок N" на "Фасадах"), не отдельная работа; здесь, в отличие от
    // "Фасадов", у такой строки ВСЕГДА пустая колонка A (см.
    // stickyPosition выше). Именно этот якорный шаблон, а не просто
    // /блок/i — тот же корень есть и у настоящей работы "Оконные блоки",
    // которую нельзя принять за подытог.
    blockMarkerRe: /^Пятно\s+\d+\s+(Блок\s+)?[\d.]/i,
    // Материалы (арматура/бетон/кирпич/плиты/утеплитель) вперемешку с
    // работами, без колонки "Категория" — исключаем по имени явно.
    // "ИТОГО:"/"В том числе:" — подытоги, не отдельные работы.
    excludeWorkNames: new Set([
      'Арматура АI Ø10', 'Арматура АI Ø6', 'Арматура АI Ø8',
      'Арматура АIII Ø10', 'Арматура АIII Ø12', 'Арматура АIII Ø14', 'Арматура АIII Ø16', 'Арматура АIII Ø20',
      'Арматура, тн', 'Арматура; тн',
      'Бетон (фундамент, пояс обвязки); м3', 'Бетон(плиты, а/п, сердечников); м3', 'Бетон, м3', 'Бетон; м3',
      'Кирпич; шт', 'Плиты м2', 'Плиты фцп; м2', 'Утеплитель; м3',
      'ИТОГО:', 'В том числе:',
    ]),
  },
  {
    key: 'brick3',
    label: 'Brick Town 3',
    sheets: [
      {
        spreadsheetId: '1k7zGcNHeM1qXXNzEBO7NCNowSp_rd2oxxl0t86dElRY',
        sheetName: 'брик таун 3',
        // Тот же шаблон, что и "брик таун 2" (см. комментарии там) — 3
        // позиции ("Пятно 1/2/3"), без "Гаража"/"Подпорных стен".
        positionMarkerRe: /^.+/,
        stickyPosition: true,
      },
    ],
    includePosition: () => true,
    blockMarkerRe: /^Пятно\s+\d+\s+(Блок\s+)?[\d.]/i,
    excludeWorkNames: new Set([
      'Арматура АI Ø10', 'Арматура АI Ø6', 'Арматура АI Ø8',
      'Арматура АIII Ø10', 'Арматура АIII Ø12', 'Арматура АIII Ø14', 'Арматура АIII Ø16', 'Арматура АIII Ø20',
      'Арматура; тн',
      'Бетон (фундамент, пояс обвязки); м3', 'Бетон(плиты, а/п, сердечников); м3', 'Бетон; м3',
      'Кирпич; шт', 'Плиты м2', 'Плиты фцп; м2', 'Утеплитель; м3',
      'ИТОГО:', 'В том числе:',
    ]),
  },
  {
    key: 'kos',
    label: 'ГПР КОС',
    sheets: [
      {
        spreadsheetId: '1WcwgMl16rUmxa9OgK0-RuOlbAAs-PjwqDgHIkYXEGuY',
        sheetName: 'план',
        // Тут "Конструктивы" — колонка ПОЗИЦИИ ("Осн.корпус", "КНС-1" и
        // т.п. — очистные сооружения, никакого поз.NN), а название самой
        // работы — в отдельной "Наименование работ" правее. Обе колонки
        // заданы явно, автопоиск по "Конструктивы" тут дал бы неверный
        // (не тот) индекс.
        positionColIndex: 1,
        workNameColIndex: 2,
        positionMarkerRe: /^.+/,
        // Колонка позиции заполнена только на первой строке каждой
        // группы работ, дальше пустая — как на "Брик Таун".
        stickyPosition: true,
      },
    ],
    includePosition: () => true,
    // "ВСЕГО:" — подытог позиции "Осн.корпус", не отдельная работа.
    // Материалы (без колонки "Категория") в конце листа, общие на весь
    // объект — исключаем по имени явно.
    excludeWorkNames: new Set(['ВСЕГО:', 'Бетон', 'Арматура', 'Кирпич', 'Утеплитель']),
  },
  {
    key: 'ekopolis2',
    label: 'ГПР Экополис поз.103,104,105',
    sheets: [{ spreadsheetId: '1kpCz-ltR4JLqy_IzEYHTvypq_DbnFRllZzfc3ck3fC8', sheetName: 'Факт' }],
    // Вся вкладка целиком — поз.103, 104, 105. Обычный шаблон (как
    // "64,72"/"НЖ3"), но: 1) "Монолитный каркас"/"Каменная кладка" на
    // некоторых позициях встречаются ДВАЖДЫ отдельными строками с
    // непересекающимися интервалами дат (видимо, разные этапы/объёмы) —
    // такое разруливает общий механизм нумерации повторов в
    // fetchAndParseSheet, не нужно ничего настраивать здесь;
    // 2) "...Предоплата"/"Плита АКП, м2"/"Утеплитель, м3" — не % готовности
    // работы, а разовая оплата/материал: явно записаны нулём на несколько
    // недель подряд, потом уходят в пустоту — под обычную логику пропуска
    // это ложно засчиталось бы как "забыли внести", хотя это не так.
    includePosition: () => true,
    excludeWorkNames: new Set([
      'Утеплитель, м3', 'Плита АКП, м2',
      'Вентиляция Предоплата', 'Витражи Предоплата', 'Лифт Предоплата',
      'Оконные блоки Предоплата', 'Отопление Предоплата', 'Фасад Предоплата и закуп фасадных люлек',
    ]),
  },
  {
    key: 'biztsentr',
    label: 'ГПР Бизнес центр',
    sheets: [
      {
        spreadsheetId: '1v1wi9oqjsmgBVaEh3jQSdSZK-dBT6bSaQlMO8DO3s3c',
        sheetName: 'план',
        // Позиции здесь — "БЦ" (бизнес-центр) и "Паркинг", не поз.NN.
        positionMarkerRe: /^.+/,
      },
    ],
    // Тот же шаблон, что и "ГПР Экополис поз.103,104,105" (см. комментарий
    // там про повторы работ и "Предоплата"). Материалы (арматура по
    // диаметрам, бетон, кирпич, плиты) без колонки "Категория" —
    // исключаем по имени явно.
    includePosition: () => true,
    excludeWorkNames: new Set([
      'Арматура; тн', 'Бетон С20/25', 'Бетон С8/10', 'Бетон; м3', 'Кирпич; шт', 'Плита АКП, м2',
      'Ф10 А240', 'Ф10 А400', 'Ф12 А400', 'Ф16 А400', 'Ф18 А400', 'Ф20 А400', 'Ф22 А400', 'Ф6 А240', 'Ф8 А240',
      'Витражное остекление Предоплата', 'Лифт Предоплата 70%',
    ]),
  },
];

const CRON_SCHEDULE = process.env.GPR_REPORT_SYNC_CRON || '0 */6 * * *';

// Excel/Sheets серийная дата -> 'YYYY-MM-DD'. origin 1899-12-30 — тот же,
// что в ноутбуке (pandas: unit='D', origin='1899-12-30'), учитывает
// исторический баг Excel с "1900 — високосный год".
function excelSerialToISODate(serial) {
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Разбирает ОДИН лист (source.sheets[i]) — источник (SOURCES[i]) может
// объединять несколько листов/таблиц под одним key (см. 'nz5': позиции
// поз.4.X с одного листа + разделы "Каток" с другого — один человек
// отвечает за оба, но структуры листов разные).
async function fetchAndParseSheet(source, sheet) {
  const raw = await getUnformattedValues(sheet.spreadsheetId, sheet.sheetName, DATA_RANGE);

  // "Окончание" на большинстве листов, "Дата окончания" — на "ГПР факт"
  // (Развязка); ищем по общему корню, а не точным совпадением.
  let labelsRowIndex = -1;
  let endColIndex = -1;
  for (let r = 0; r < Math.min(raw.length, LABELS_SEARCH_ROWS); r++) {
    const idx = (raw[r] || []).findIndex((v) => typeof v === 'string' && /оконч/i.test(v));
    if (idx !== -1) {
      labelsRowIndex = r;
      endColIndex = idx;
      break;
    }
  }
  if (labelsRowIndex === -1) {
    throw new Error(`[${source.key}] не найдена колонка "Окончание" в первых строках листа "${sheet.sheetName}"`);
  }
  const labelsRow = raw[labelsRowIndex];
  const firstDateCol = endColIndex + 1;

  // Плановые начало/конец раздела (см. gpr_report_plan_dates в db.js) —
  // необязательная колонка: если на каком-то листе её нет, просто не будет
  // плановых дат для этого источника, синк остальных данных не ломаем.
  const startColIndex = labelsRow.findIndex((v) => typeof v === 'string' && /начал/i.test(v));

  // На "ГПР факт" (Развязка) колонки "Конструктивы" вообще нет — само
  // название работы там без подписи в строке заголовков (соседняя ячейка
  // "Объем работы" — это подпись для КОЛИЧЕСТВА, не имени работы), поэтому
  // индекс колонки задаётся явно через sheet.workNameColIndex.
  let workNameColIndex = sheet.workNameColIndex;
  if (workNameColIndex === undefined) {
    workNameColIndex = labelsRow.findIndex((v) => typeof v === 'string' && v.trim() === 'Конструктивы');
    if (workNameColIndex === -1) {
      throw new Error(`[${source.key}] не найдена колонка "Конструктивы" в строке заголовков листа "${sheet.sheetName}"`);
    }
  }

  // Колонка позиции — обычно A (0); на "ГПР КОС" сама подпись
  // "Конструктивы" (обычно означающая название работы) на самом деле —
  // колонка позиции ("Осн.корпус", "КНС-1" и т.п.), а название работы —
  // в отдельной "Наименование работ" правее, поэтому обе колонки заданы
  // явно через sheet.workNameColIndex/positionColIndex, без автопоиска.
  const positionColIndex = sheet.positionColIndex ?? 0;

  // Категория строки ("Работа"/"Материал") — есть не у всех листов; если
  // колонки нет, ниже просто ничего не фильтруется по ней.
  const categoryColIndex = labelsRow.findIndex((v) => typeof v === 'string' && v.trim() === 'Категория');

  // Некоторые листы (например "64,72", "факт") дописывают справа побочную
  // таблицу "Остаток по КС" (сверка оплат) — свои даты-маркеры (тоже
  // правдоподобные serial-числа) и суммы в тенге, начинающуюся с текстовых
  // подписей вроде "Доля"/"Сумма по КС"/"Остаток"/"НДС ...%" в строке
  // подписей. Отсекаем недельные колонки ДО первой такой текстовой ячейки
  // после firstDateCol — иначе побочная таблица подмешивает свои
  // даты-маркеры к недельным (реальная коллизия: те же календарные даты на
  // ДРУГИХ номерах колонок дают дубликат в БД). Ищем ИМЕННО эти ключевые
  // слова, а не любую текстовую ячейку — у листа "ГПР" (Каток) сам год
  // ("2025") почему-то записан строкой, а не числом, прямо в firstDateCol,
  // и без этого сужения ложно обнулил бы вообще все недельные колонки.
  const BOUNDARY_KEYWORD_RE = /сумма|остаток|доля|ндс|категория/i;
  let boundaryCol = Infinity; // нет ключевого слова в пределах labelsRow — значит, побочной таблицы нет, границу не ставим
  for (let c = firstDateCol; c < labelsRow.length; c++) {
    if (typeof labelsRow[c] === 'string' && BOUNDARY_KEYWORD_RE.test(labelsRow[c])) {
      boundaryCol = c;
      break;
    }
  }

  // Недельные даты — в строке(-ах) на sheet.dateRowOffsets ниже строки
  // подписей (по умолчанию [2] — так исторически устроены все листы, кроме
  // "факт", где 2025 год и 2026-2027 годы прописаны в двух строках подряд,
  // offset [1, 2]).
  const dateColumnsMap = new Map(); // colIndex -> reportDate
  for (const offset of sheet.dateRowOffsets || [2]) {
    const row = raw[labelsRowIndex + offset] || [];
    for (let c = firstDateCol; c < Math.min(row.length, boundaryCol); c++) {
      const v = row[c];
      if (
        typeof v === 'number' &&
        Number.isFinite(v) &&
        v >= MIN_DATE_SERIAL &&
        v <= MAX_DATE_SERIAL &&
        !dateColumnsMap.has(c)
      ) {
        dateColumnsMap.set(c, excelSerialToISODate(v));
      }
    }
  }
  const dateColumns = [...dateColumnsMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([colIndex, reportDate]) => ({ colIndex, reportDate }));

  // Первая строка данных — динамически ищем начиная сразу после подписей.
  // Обычный случай: как только встречаем маркер позиции 'поз.NN' в колонке
  // A, либо "Позиция N" (итоговая сводка) в колонке "Конструктивы". Именно
  // \s, а не \b — у кириллицы JS-регэксп \b не работает ожидаемо ("я" не
  // считается символом \w), так что "Позиция\b" не совпадёт вообще.
  // sheet.sectionsArePositions/stagedSections (см. ниже) — колонки
  // "позиция" вообще нет, поэтому границей данных считаем первую строку с
  // непустым названием работы/раздела.
  let firstDataRowIndex = labelsRowIndex + 1;
  for (let r = labelsRowIndex + 1; r < raw.length; r++) {
    const row = raw[r] || [];
    const pos0 = (row[positionColIndex] || '').toString().trim();
    const workCell = (row[workNameColIndex] || '').toString().trim();
    const isDataBoundary =
      sheet.sectionsArePositions || sheet.stagedSections || sheet.stickyPosition
        ? pos0 !== '' || workCell !== ''
        : (sheet.positionMarkerRe || POSITION_MARKER_RE).test(pos0) || /^Позиция\s/i.test(workCell);
    if (isDataBoundary) {
      firstDataRowIndex = r;
      break;
    }
    firstDataRowIndex = r + 1;
  }

  const rows = [];
  const planRows = [];
  // Одна и та же работа изредка встречается ДВАЖДЫ под одной позицией на
  // отдельных строках с непересекающимися интервалами дат (см. "ГПР
  // Экополис поз. 103,104,105": "Монолитный каркас"/"Каменная кладка" —
  // видимо, разные этапы/объёмы одной и той же работы без своей подписи).
  // Реальные, не мусорные данные — просто разруливаем коллизию ключа,
  // нумеруя повторы, а не отбрасываем.
  const workNameOccurrences = new Map(); // "position|block|workName" -> счётчик
  let currentPosition = '';
  let currentBlock = '';
  // true сразу после того, как строка-заголовок блока (blockMarkerRe, без
  // своей позиции в колонке A — см. sheet.stickyPosition) установила
  // currentBlock, до ближайшей строки, которая заново укажет позицию в
  // колонке A. Не даёт стандартному сбросу блока при "смене" позиции
  // затереть только что установленный блок — на "Брик Таун" маркер блока
  // всегда идёт ПЕРЕД строкой, повторно указывающей ту же позицию.
  let blockJustSet = false;
  // Две строки-подытога блока подряд без единой строки данных между ними
  // — не бывает в реальных данных (на "Брик Таун 3" между подытогами
  // всегда десятки строк работ) — встречается только в хвостовом мусоре
  // исходника (см. лист "брик таун 3": в конце список подытогов блоков
  // повторяется без самих данных, со старой "залипшей" позицией — если
  // это не отловить, часть строк получит неверную позицию, а часть даст
  // дубликат ключа и упадёт на UNIQUE-ограничении). При обнаружении —
  // считаем, что реальные данные листа закончились, и останавливаемся.
  let lastWasBlockMarker = false;
  // Две ПОЛНОСТЬЮ пустые строки подряд (ни одной заполненной ячейки нигде)
  // — тоже сигнал конца реальных данных (см. "брик таун 3": после
  // подытога последнего блока идёт 6 таких строк, а за ними — ещё раз
  // пустой повтор списка работ без единого значения, и только потом уже
  // хвостовой список подытогов блоков, который ловит lastWasBlockMarker
  // выше). Внутри настоящих данных обоих листов "Брик Таун" такого не
  // встречается — проверено сканированием всего листа.
  let consecutiveBlankRows = 0;
  for (let r = firstDataRowIndex; r < raw.length; r++) {
    const row = raw[r];
    if (!row || !row.length) {
      consecutiveBlankRows++;
      if (consecutiveBlankRows >= 2) break;
      continue;
    }
    consecutiveBlankRows = 0;

    let position;
    let workName;

    if (sheet.sectionsArePositions) {
      // Нет колонки "позиция" (поз.NN) — весь объект описан плоским
      // списком работ, сгруппированным заголовками-разделами (например
      // "Административный блок"/"Ледовый зал" на листе "ГПР" Катка).
      // Колонка A здесь — не маркер позиции, а тип строки (у Катка всегда
      // "план") и сама по себе не используется.
      const col0 = (row[0] || '').toString().trim();
      const workCell = (row[workNameColIndex] || '').toString().trim();
      if (!col0) {
        if (workCell) currentPosition = workCell; // заголовок раздела — контекст, не данные
        continue;
      }
      if (!currentPosition) continue; // строка данных раньше первого заголовка раздела — не должно происходить
      position = currentPosition;
      workName = workCell;
      if (!workName) continue;
    } else if (sheet.stagedSections) {
      // Двухуровневая группировка вместо позиций: "N этап" (например
      // "1 этап", "2 этап (путепроводы)") — верхний уровень, становится
      // "позицией"; вложенные заголовки-разделы (например "Демонтажные
      // работы", "Автомобильные дороги" — их названия ПОВТОРЯЮТСЯ в
      // разных этапах, поэтому одни, без этапа, для "позиции" не годятся)
      // — становится "блоком". И то, и другое — строка-заголовок с
      // текстом ТОЛЬКО в колонке A, остальное пусто (см. "ГПР факт",
      // Развязка).
      const col0 = (row[0] || '').toString().trim();
      const workCell = (row[workNameColIndex] || '').toString().trim();
      if (col0 && !workCell) {
        if ((sheet.stageMarkerRe || STAGE_MARKER_RE).test(col0)) {
          currentPosition = col0;
          currentBlock = '';
        } else {
          currentBlock = col0;
        }
        continue;
      }
      if (!col0 && workCell) {
        if (!currentPosition) continue; // строка данных раньше первого "N этап" — не должно происходить
        position = currentPosition;
        workName = workCell;
      } else {
        continue; // ни заголовок, ни данные (например, полностью пустая строка)
      }
    } else {
      const pos0 = (row[positionColIndex] || '').toString().trim();
      const workCellRaw = (row[workNameColIndex] || '').toString().trim();
      const positionMarkerRe = sheet.positionMarkerRe || POSITION_MARKER_RE;

      if (!pos0 && sheet.stickyPosition) {
        // Строка-заголовок без своей позиции в колонке позиции (например
        // "Брик Таун" — колонка A заполняется только на ПЕРВОЙ строке
        // каждой группы, дальше пустая до следующей группы). Тут это либо
        // подытог блока (например "Пятно 3 3.1 блок" — см.
        // source.blockMarkerRe), либо "анонс" следующей позиции без
        // блока (например "Гараж"/"Подпорные стены" — та же строка, что
        // появится в колонке позиции уже на следующей строке). Ни то, ни
        // другое не данные — пропускаем, не трогая уже накопленные
        // currentPosition/currentBlock.
        if (source.blockMarkerRe && source.blockMarkerRe.test(workCellRaw)) {
          if (lastWasBlockMarker) break; // хвостовой мусор — см. комментарий у lastWasBlockMarker
          currentBlock = workCellRaw;
          blockJustSet = true;
          lastWasBlockMarker = true;
          continue;
        }
        const nextPos0 = ((raw[r + 1] || [])[positionColIndex] || '').toString().trim();
        if (nextPos0 && workCellRaw === nextPos0) continue; // анонс следующей позиции, без блока
      }

      if (pos0) {
        if (!positionMarkerRe.test(pos0)) continue; // "Позиция N" — итоговая строка, не данные
        if (pos0 !== currentPosition) {
          currentPosition = pos0;
          if (!blockJustSet) currentBlock = '';
        }
        blockJustSet = false;
      } else if (!sheet.stickyPosition) {
        continue; // без stickyPosition пустая колонка A = не данные (например "Позиция N")
      }

      position = currentPosition;
      if (!position) continue; // строка данных раньше первой позиции — не должно происходить
      workName = workCellRaw;
      if (!workName) continue;
    }

    if (!source.includePosition(position)) continue;

    if (source.blockMarkerRe && source.blockMarkerRe.test(workName)) {
      if (lastWasBlockMarker) break; // хвостовой мусор — см. комментарий у lastWasBlockMarker
      currentBlock = workName; // подытог блока, не отдельная работа — только запоминаем контекст
      lastWasBlockMarker = true;
      continue;
    }
    lastWasBlockMarker = false;

    if (source.excludeWorkNames.has(workName)) continue;

    if (categoryColIndex !== -1) {
      const category = (row[categoryColIndex] || '').toString().trim();
      if (category === 'Материал') continue; // расход материала, не % готовности работы
    }

    const occurrenceKey = `${position}|${currentBlock}|${workName}`;
    const occurrence = (workNameOccurrences.get(occurrenceKey) || 0) + 1;
    workNameOccurrences.set(occurrenceKey, occurrence);
    const storedWorkName = occurrence > 1 ? `${workName} (${occurrence})` : workName;

    // Начало/конец — одно значение на весь раздел (не по неделям, в
    // отличие от dateColumns ниже), поэтому читаются один раз здесь.
    if (startColIndex !== -1) {
      const startCell = row[startColIndex];
      const endCell = row[endColIndex];
      const isDateSerial = (v) => typeof v === 'number' && Number.isFinite(v) && v >= MIN_DATE_SERIAL && v <= MAX_DATE_SERIAL;
      planRows.push({
        source_key: source.key,
        position,
        block: currentBlock,
        work_name: storedWorkName,
        plan_start: isDateSerial(startCell) ? excelSerialToISODate(startCell) : null,
        plan_end: isDateSerial(endCell) ? excelSerialToISODate(endCell) : null,
      });
    }

    for (const { colIndex, reportDate } of dateColumns) {
      const cell = row[colIndex];
      let percent = null;
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        percent = cell * 100;
      } else if (typeof cell === 'string' && cell.trim() !== '') {
        const parsed = parseFloat(cell.replace(',', '.'));
        if (!Number.isNaN(parsed)) percent = parsed * 100;
      }
      // cell === undefined/''/null -> percent остаётся null (пусто в исходнике)
      rows.push({
        source_key: source.key,
        source_label: source.label,
        position,
        block: currentBlock,
        work_name: storedWorkName,
        report_date: reportDate,
        percent,
      });
    }
  }

  return { rows, planRows };
}

// Отдельная вкладка с плановыми сроками (source.planSheet) — плоская
// таблица "Объект | Позиция | Раздел работ | Дата начала | Дата окончания",
// позиция ("Поз.1.1") заполнена только в первой строке своего блока.
// Названия разделов — те же, что в колонке "Конструктивы" листа с % (по
// ним финплан сопоставляет план и факт).
async function fetchPlanSheet(source) {
  const { spreadsheetId, sheetName } = source.planSheet;
  const raw = await getUnformattedValues(spreadsheetId, sheetName, DATA_RANGE);

  const headerIndex = raw
    .slice(0, LABELS_SEARCH_ROWS)
    .findIndex((row) => (row || []).some((v) => typeof v === 'string' && v.trim() === 'Раздел работ'));
  if (headerIndex === -1) {
    throw new Error(`[${source.key}] не найдена колонка "Раздел работ" на листе плана "${sheetName}"`);
  }
  const header = raw[headerIndex].map((v) => (typeof v === 'string' ? v.trim() : v));
  const positionCol = header.indexOf('Позиция');
  const workCol = header.indexOf('Раздел работ');
  const startCol = header.findIndex((v) => typeof v === 'string' && /начал/i.test(v));
  const endCol = header.findIndex((v) => typeof v === 'string' && /оконч/i.test(v));
  if ([positionCol, startCol, endCol].includes(-1)) {
    throw new Error(`[${source.key}] на листе плана "${sheetName}" нет колонок "Позиция"/"Дата начала"/"Дата окончания"`);
  }

  const isDateSerial = (v) => typeof v === 'number' && Number.isFinite(v) && v >= MIN_DATE_SERIAL && v <= MAX_DATE_SERIAL;
  const planRows = [];
  let position = null;
  for (const row of raw.slice(headerIndex + 1)) {
    const positionCell = (row[positionCol] || '').toString().trim().toLowerCase(); // "Поз.1.1" -> "поз.1.1", как на листе "факт"
    if (positionCell) position = POSITION_MARKER_RE.test(positionCell) ? positionCell : null;
    const workName = (row[workCol] || '').toString().trim();
    if (!position || !workName) continue; // пустые строки и пояснение под таблицей
    planRows.push({
      source_key: source.key,
      position,
      block: '', // как у строк без блока в fetchAndParseSheet
      work_name: workName,
      plan_start: isDateSerial(row[startCol]) ? excelSerialToISODate(row[startCol]) : null,
      plan_end: isDateSerial(row[endCol]) ? excelSerialToISODate(row[endCol]) : null,
    });
  }
  if (!planRows.length) {
    throw new Error(`[${source.key}] на листе плана "${sheetName}" не найдено ни одной строки`);
  }
  return planRows;
}

// Все листы одного источника; плановые сроки — с source.planSheet, если он
// задан (тогда "Начало"/"Окончание" листов с % игнорируются).
async function fetchAndParseSource(source) {
  const rows = [];
  let planRows = [];
  for (const sheet of source.sheets) {
    const { rows: sheetRows, planRows: sheetPlanRows } = await fetchAndParseSheet(source, sheet);
    rows.push(...sheetRows);
    planRows.push(...sheetPlanRows);
  }
  if (source.planSheet) planRows = await fetchPlanSheet(source);
  return { rows, planRows };
}

async function fetchAndParse() {
  const allRows = [];
  const allPlanRows = [];
  for (const source of SOURCES) {
    const { rows, planRows } = await fetchAndParseSource(source);
    allRows.push(...rows);
    allPlanRows.push(...planRows);
  }
  return { rows: allRows, planRows: allPlanRows };
}

// sourceKeys — null для полного пересинка (все источники, старое
// поведение: удаляем всю таблицу и вставляем всё заново); массив ключей —
// для точечного пересинка (resyncSource ниже): удаляем только строки ЭТИХ
// источников, остальные (даже не пересинканные сейчас) не трогаем.
function storeValues(rows, sourceKeys = null) {
  const db = getWriteDb();
  const insert = db.prepare(`
    INSERT INTO gpr_report_values (source_key, source_label, position, block, work_name, report_date, percent)
    VALUES (@source_key, @source_label, @position, @block, @work_name, @report_date, @percent)
  `);
  const upsertMeta = db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const deleteBySource = db.prepare(`DELETE FROM gpr_report_values WHERE source_key = ?`);
  const countAll = db.prepare(`SELECT COUNT(*) as c FROM gpr_report_values`);

  const replace = db.transaction((someRows) => {
    if (sourceKeys) {
      for (const key of sourceKeys) deleteBySource.run(key);
    } else {
      db.prepare(`DELETE FROM gpr_report_values`).run();
    }
    for (const row of someRows) insert.run(row);
    upsertMeta.run({ key: 'gpr_report_last_synced_at', value: new Date().toISOString() });
    upsertMeta.run({ key: 'gpr_report_row_count', value: String(countAll.get().c) });
  });

  replace(rows);
  return rows.length;
}

function storePlanDates(planRows, sourceKeys = null) {
  const db = getWriteDb();
  const insert = db.prepare(`
    INSERT INTO gpr_report_plan_dates (source_key, position, block, work_name, plan_start, plan_end)
    VALUES (@source_key, @position, @block, @work_name, @plan_start, @plan_end)
  `);
  const deleteBySource = db.prepare(`DELETE FROM gpr_report_plan_dates WHERE source_key = ?`);

  const replaceAll = db.transaction((allRows) => {
    if (sourceKeys) {
      for (const key of sourceKeys) deleteBySource.run(key);
    } else {
      db.prepare(`DELETE FROM gpr_report_plan_dates`).run();
    }
    for (const row of allRows) insert.run(row);
  });

  replaceAll(planRows);
  return planRows.length;
}

// Точечный пересинк ОДНОГО источника (а не всех SOURCES, как runSyncOnce)
// — вызывается синхронно перед открытием финплана (services/financing-api,
// см. build_financing_plan.py:build_object_plan), чтобы данные не ждали
// следующего планового кронового прогона (раз в CRON_SCHEDULE, по
// умолчанию 6 часов). Один источник — обычно один-два листа, занимает
// секунды, а не полный обход всех источников.
async function resyncSource(sourceKey) {
  const source = SOURCES.find((s) => s.key === sourceKey);
  if (!source) throw new Error(`Неизвестный источник ГПР: ${sourceKey}`);

  const { rows, planRows } = await fetchAndParseSource(source);

  const count = storeValues(rows, [sourceKey]);
  const planCount = storePlanDates(planRows, [sourceKey]);
  console.log(`[gpr-report-sync] точечный пересинк '${sourceKey}': ${count} значений, ${planCount} плановых сроков`);
  return { count, planCount };
}

// Контрольный рубеж — пятница, за которую уже наступил срок отчитаться.
// Отчёты заполняются каждую пятницу, но срок наступает не в саму пятницу,
// а во ВТОРНИК после неё — у ответственных остаются суббота, воскресенье
// и понедельник на дозаполнение без блокировки. Поэтому с пятницы по
// понедельник включительно рубежом всё ещё считается пятница НЕДЕЛЕЙ
// РАНЬШЕ (та, что уже прошла свой вторник), и только начиная со вторника
// рубеж сдвигается на только что прошедшую пятницу. Например, если
// сегодня вторник 11.08.2026 или позже (до следующей пятницы) — рубеж
// пятница 07.08.2026; если сегодня пятница/суббота/воскресенье/
// понедельник 07-10.08.2026 — рубеж всё ещё пятница 31.07.2026.
function lastFridayOnOrBefore(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Вс ... 5=Пт ... 6=Сб
  const diffToFriday = (day - 5 + 7) % 7; // сколько дней назад была последняя пятница (0, если сегодня пятница)
  d.setDate(d.getDate() - diffToFriday);
  if (diffToFriday < 4) {
    // Сегодня пт/сб/вс/пн после этой пятницы — срок ещё не наступил,
    // откатываемся на пятницу неделей раньше.
    d.setDate(d.getDate() - 7);
  }
  return d;
}

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Пропуск = (источник, позиция, конструктив), у которого ЕСТЬ хоть одна
// заполненная неделя раньше (значит, работа реально идёт — это не "ещё не
// начали"), но после последней заполненной недели и вплоть до контрольной
// пятницы остались пустые ячейки. Проверено на реальных данных исходника:
// конструктивы, дошедшие до 100%, продолжают явно перезаполняться каждую
// неделю (100% повторяется, а не оставляется пустым) — пустой хвост
// появляется только у ещё незавершённых работ, то есть это настоящий
// "забыли занести", а не "работа закончена, дальше нечего репортить".
// Считает СРАЗУ по всем источникам (SOURCES) — вызывающий код (админ-панель,
// проверка блокировки email) не завязан на конкретный лист/позицию.
function computeGprReportGaps({ asOf } = {}) {
  const db = getWriteDb();
  const cutoffDate = lastFridayOnOrBefore(asOf || new Date());
  const cutoff = toISODate(cutoffDate);

  const rows = db
    .prepare(
      `SELECT source_key, source_label, position, block, work_name, report_date, percent
       FROM gpr_report_values
       WHERE report_date <= ?
       ORDER BY source_key, position, block, work_name, report_date`
    )
    .all(cutoff);

  const byGroup = new Map();
  for (const row of rows) {
    const key = `${row.source_key}|${row.position}|${row.block}|${row.work_name}`;
    if (!byGroup.has(key)) byGroup.set(key, { meta: row, entries: [] });
    byGroup.get(key).entries.push(row);
  }

  const gaps = [];
  for (const { meta, entries } of byGroup.values()) {
    let lastFilledIndex = -1;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].percent !== null) lastFilledIndex = i;
    }
    if (lastFilledIndex === -1) continue; // работа ещё ни разу не заполнялась — не пропуск, а "не начата"

    const missingDates = entries.slice(lastFilledIndex + 1).map((e) => e.report_date);
    if (missingDates.length) {
      gaps.push({
        source_key: meta.source_key,
        source_label: meta.source_label,
        position: meta.position,
        block: meta.block,
        work_name: meta.work_name,
        last_filled_date: entries[lastFilledIndex].report_date,
        last_filled_percent: entries[lastFilledIndex].percent,
        missing_dates: missingDates,
      });
    }
  }

  return { cutoff, gaps };
}

async function runSyncOnce() {
  const { rows, planRows } = await fetchAndParse();
  const count = storeValues(rows);
  const planCount = storePlanDates(planRows);
  console.log(
    `[gpr-report-sync] загружено ${count} значений, ${planCount} плановых сроков (${SOURCES.map((s) => s.key).join(', ')})`
  );
  return count;
}

function startGprReportSync() {
  runSyncOnce().catch((err) => console.error('[gpr-report-sync] ошибка стартового синка:', err.message));
  cron.schedule(CRON_SCHEDULE, () => {
    runSyncOnce().catch((err) => console.error('[gpr-report-sync] ошибка планового синка:', err.message));
  });
}

module.exports = {
  startGprReportSync,
  runSyncOnce,
  resyncSource,
  computeGprReportGaps,
  lastFridayOnOrBefore,
  SOURCES,
};
