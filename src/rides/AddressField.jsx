// Поле адреса в заявке: населённый пункт + улица, с обязательной точкой на карте.
//
// Населённый пункт — выпадающий список (Усть-Каменогорск по умолчанию и
// первым, остальные по алфавиту, см. server/rides/settlements.js) либо
// «Другой» — вписать вручную; вписанное проверяется по карте
// (GET /api/v1/geocode/settlement): пока название не подтверждено, заявку не
// отправить, при опечатке показываем, как пишется правильно. Улица ищется
// только внутри выбранного населённого пункта.
//
// Затем адрес проверяется (GET /api/v1/geocode/check): найден точно —
// точка берётся оттуда; найдена только улица, не найден или сервис поиска
// не ответил — нужно отметить точку на карте (MapPicker), иначе заявку не
// отправить (сервер проверяет то же, server/rides/addressCheck.js). Точка
// с карты главнее текста: текст можно уточнять дальше («склад №2»), точка
// остаётся, пока её не сбросят.
//
// Значение поля: { city, address, point: { lat, lng, manual } | null, status, hint }
//   city: { name, custom, status: ok | empty | checking | not_found | unavailable, lat, lng, suggestions }
//   address — улица, дом (без населённого пункта, его добавляет addressPayload);
//   status: idle | checking | found | street | not_found | unavailable | manual
//   hint — где открыть карту (найденная улица).
import React, { useEffect, useRef, useState } from "react";
import MapPicker from "./MapPicker";
import { ridesApiFetch } from "./api";

export const DEFAULT_CITY = "г. Усть-Каменогорск";
const OTHER = "__other__";

export const emptyAddress = {
  city: { name: DEFAULT_CITY, custom: false, status: "ok" },
  address: "", point: null, status: "idle", hint: null,
};
export const cityReady = (v) => v.city.status === "ok";
// Населённый пункт не подтверждён — заявку не отправить.
export const cityProblem = (v) => !!v.address.trim() && !cityReady(v) && v.city.status !== "checking";
export const addressReady = (v) => !v.address.trim() || (cityReady(v) && !!v.point);
export const addressNeedsMap = (v) => !!v.address.trim() && cityReady(v) && !v.point && ["street", "not_found", "unavailable"].includes(v.status);

const CHECK_DELAY_MS = 700;

const NEED_MAP_TEXT = {
  street: "Найдена только улица, без дома. Нажмите «На карте» и отметьте нужное здание — так время в пути и километраж будут рассчитаны точно.",
  not_found: "Адрес не найден на карте. Нажмите «На карте» и отметьте точку — так время в пути и километраж будут рассчитаны точно.",
  unavailable: "Не удалось проверить адрес. Нажмите «На карте» и отметьте точку — так время в пути и километраж будут рассчитаны точно.",
};

// Список населённых пунктов — один запрос на страницу, общий для всех полей.
let settlementsPromise = null;
function loadSettlements() {
  if (!settlementsPromise) {
    settlementsPromise = ridesApiFetch("/api/v1/geocode/settlements")
      .then((r) => r.settlements)
      .catch(() => {
        settlementsPromise = null; // повторим при следующем открытии формы
        return [{ name: DEFAULT_CITY, lat: 49.9484, lng: 82.6275 }];
      });
  }
  return settlementsPromise;
}

export default function AddressField({ value, onChange, placeholder = "Улица, дом", inputStyle, buttonStyle, mapTitle }) {
  const [mapOpen, setMapOpen] = useState(false);
  const [settlements, setSettlements] = useState([{ name: DEFAULT_CITY }]);
  const valueRef = useRef(value);
  valueRef.current = value;
  const manual = !!value.point?.manual;
  const { city } = value;

  useEffect(() => {
    let alive = true;
    loadSettlements().then((list) => { if (alive) setSettlements(list); });
    return () => { alive = false; };
  }, []);

  // Вписанный вручную населённый пункт — проверка по карте с задержкой.
  useEffect(() => {
    const name = city.name.trim();
    if (!city.custom || city.status !== "checking" || !name) return undefined;
    const t = setTimeout(async () => {
      let res;
      try {
        res = await ridesApiFetch(`/api/v1/geocode/settlement?name=${encodeURIComponent(name)}`);
      } catch {
        res = { status: "unavailable" };
      }
      const cur = valueRef.current;
      if (cur.city.name.trim() !== name || !cur.city.custom) return;
      onChange({
        ...cur,
        city: res.status === "found"
          ? { name: res.name, custom: true, status: "ok", lat: res.lat, lng: res.lng }
          : { name, custom: true, status: res.status, suggestions: res.suggestions || [] },
        status: "idle",
      });
    }, CHECK_DELAY_MS);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city.name, city.status, city.custom]);

  // Проверка адреса — с задержкой после ввода; ответ на устаревший текст игнорируем.
  useEffect(() => {
    const address = value.address.trim();
    if (!address || manual || value.status !== "idle" || !cityReady(value)) return undefined;
    const full = fullAddress(value);
    const t = setTimeout(async () => {
      onChange({ ...valueRef.current, status: "checking" });
      let res;
      try {
        res = await ridesApiFetch(`/api/v1/geocode/check?address=${encodeURIComponent(full)}`);
      } catch {
        res = { status: "unavailable" };
      }
      const cur = valueRef.current;
      if (fullAddress(cur) !== full || cur.point?.manual) return;
      const at = res.lat != null ? { lat: res.lat, lng: res.lng } : null;
      onChange(res.status === "found"
        ? { ...cur, status: "found", point: { ...at, manual: false }, hint: at }
        : { ...cur, status: res.status, point: null, hint: at });
    }, CHECK_DELAY_MS);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.address, value.status, manual, city.name, city.status]);

  const setText = (address) => onChange(manual
    ? { ...value, address } // точка отмечена — текст лишь подпись
    : { ...value, address, point: null, status: "idle" });

  // Сменили населённый пункт — прежняя точка (и найденная, и отмеченная) уже не та.
  const setCity = (nextCity) => onChange({ ...value, city: nextCity, point: null, status: "idle", hint: null });
  const typeCity = (name) => setCity({ name, custom: true, status: name.trim() ? "checking" : "empty" });
  const pickFromList = (name) => {
    if (name === OTHER) return typeCity("");
    const s = settlements.find((x) => x.name === name);
    return setCity({ name, custom: false, status: "ok", lat: s?.lat, lng: s?.lng });
  };
  // Подсказка из списка — сразу «как из списка», без повторной проверки.
  const takeSuggestion = (name) => {
    const s = settlements.find((x) => x.name === name);
    return s ? pickFromList(name) : typeCity(name);
  };

  const cityCenter = city.lat != null ? { lat: city.lat, lng: city.lng }
    : settlements.find((x) => x.name === city.name && x.lat != null) || null;
  const needMap = addressNeedsMap(value);
  return (
    <div style={st.wrap}>
      <div style={st.row}>
        <select style={{ ...inputStyle, ...st.city }} value={city.custom ? OTHER : city.name} onChange={(e) => pickFromList(e.target.value)}>
          {settlements.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
          <option value={OTHER}>Другой — вписать…</option>
        </select>
        <input style={{ ...inputStyle, flex: "2 1 180px", ...(needMap ? st.inputWarn : null) }} value={value.address} placeholder={placeholder}
          onChange={(e) => setText(e.target.value)} />
        <button type="button" style={{ ...buttonStyle, ...(needMap ? st.buttonWarn : null) }} onClick={() => setMapOpen(true)}
          disabled={!cityReady(value)} title={!cityReady(value) ? "Сначала укажите населённый пункт" : undefined}>
          На карте
        </button>
      </div>
      {city.custom && (
        <>
          <input style={{ ...inputStyle, ...(cityProblem(value) ? st.inputWarn : null) }} value={city.name} autoFocus
            placeholder="Населённый пункт, например: с. Ивановка" onChange={(e) => typeCity(e.target.value)} />
          {city.status === "checking" && <div style={st.muted}>Проверяем населённый пункт…</div>}
          {city.status === "ok" && <div style={st.ok}>✓ Населённый пункт найден: {city.name}</div>}
          {city.status === "unavailable" && (
            <div style={st.warn}>⚠️ Не удалось проверить населённый пункт — попробуйте ещё раз чуть позже.{" "}
              <button type="button" style={st.link} onClick={() => typeCity(city.name)}>Проверить снова</button>
            </div>
          )}
          {city.status === "not_found" && (
            <div style={st.warn}>
              ⚠️ Населённый пункт «{city.name}» не найден в ВКО и Абайской области — проверьте написание.
              {city.suggestions?.length > 0 && (
                <div>Возможно:{" "}
                  {city.suggestions.map((name, i) => (
                    <React.Fragment key={name}>
                      {i > 0 && ", "}
                      <button type="button" style={st.link} onClick={() => takeSuggestion(name)}>{name}</button>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {value.status === "checking" && <div style={st.muted}>Ищем адрес на карте…</div>}
      {value.status === "found" && value.address.trim() && <div style={st.ok}>✓ Адрес найден на карте</div>}
      {manual && (
        <div style={st.ok}>
          ✓ Точка отмечена на карте{" "}
          <button type="button" style={st.link} onClick={() => setMapOpen(true)}>Изменить</button>{" "}
          <button type="button" style={st.link} onClick={() => onChange({ ...value, point: null, status: "idle" })}>Сбросить</button>
        </div>
      )}
      {needMap && <div style={st.warn}>⚠️ {NEED_MAP_TEXT[value.status]}</div>}
      {mapOpen && (
        <MapPicker
          title={mapTitle}
          initialAddress={value.address}
          center={value.point || value.hint}
          centerIsPoint={!!value.point}
          cityCenter={cityCenter}
          onClose={() => setMapOpen(false)}
          onSelect={(address, p) => {
            onChange({ ...value, address, point: { lat: p.lat, lng: p.lng, manual: true }, status: "manual" });
            setMapOpen(false);
          }}
        />
      )}
    </div>
  );
}

// «г. Семей, ул. Ленина, 5» — так адрес хранится и его видит водитель;
// сервер по первой части понимает, в каком населённом пункте искать улицу.
function fullAddress(v) {
  const street = v.address.trim();
  return street ? `${v.city.name.trim()}, ${street}` : "";
}

// Для отправки: адрес и координаты точки.
export const addressPayload = (v) => ({ address: fullAddress(v), lat: v.point?.lat, lng: v.point?.lng });

const st = {
  wrap: { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 },
  row: { display: "flex", gap: 8, flexWrap: "wrap" },
  city: { flex: "1 1 170px", minWidth: 0 },
  inputWarn: { borderColor: "#e0a800", background: "#fffaf0" },
  buttonWarn: { borderColor: "#e0a800", background: "#fff3c4", fontWeight: 600 },
  muted: { fontSize: 12, color: "#777" },
  ok: { fontSize: 12, color: "#1a7f37" },
  warn: { fontSize: 12, color: "#8a5a00", background: "#fff6e0", borderRadius: 6, padding: "6px 8px", lineHeight: 1.4 },
  link: { background: "none", border: "none", color: "#1976d2", cursor: "pointer", padding: 0, fontSize: 12, textDecoration: "underline" },
};
