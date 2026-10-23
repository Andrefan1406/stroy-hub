// Реестр разделов проекта. КЖ — первый тип, а не частный случай: чтобы
// добавить АР, КР, ОВ, ВК или ЭОМ, достаточно описать здесь свой разбор PDF
// и правила видов работ; хранение, расценки, итоги и Excel общие.
const { parseKzh } = require('./parsers/kzh');
const { deriveWorks } = require('./works');

const SECTIONS = {
  КЖ: {
    code: 'КЖ',
    title: 'КЖ — конструкции железобетонные',
    parse: parseKzh, // (pages) -> { rows, issues, sheets }
    deriveWorks, // (items) -> works
  },
};

const sectionList = () => Object.values(SECTIONS).map(({ code, title }) => ({ code, title }));

module.exports = { SECTIONS, sectionList };
