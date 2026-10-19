// Поле адреса в заявке с обязательной точкой на карте.
//
// После ввода адрес проверяется (GET /api/v1/geocode/check): найден точно —
// точка берётся оттуда; найдена только улица, не найден или сервис поиска
// не ответил — нужно отметить точку на карте (MapPicker), иначе заявку не
// отправить (сервер проверяет то же, server/rides/addressCheck.js). Точка
// с карты главнее текста: текст можно уточнять дальше («склад №2»), точка
// остаётся, пока её не сбросят.
//
// Значение поля: { address, point: { lat, lng, manual } | null, status, hint }
//   status: idle | checking | found | street | not_found | unavailable | manual
//   hint — где открыть карту (найденная улица).
import React, { useEffect, useRef, useState } from "react";
import MapPicker from "./MapPicker";
import { ridesApiFetch } from "./api";

export const emptyAddress = { address: "", point: null, status: "idle", hint: null };
export const addressReady = (v) => !v.address.trim() || !!v.point;
export const addressNeedsMap = (v) => !!v.address.trim() && !v.point && ["street", "not_found", "unavailable"].includes(v.status);

const CHECK_DELAY_MS = 700;

const NEED_MAP_TEXT = {
  street: "Найдена только улица, без дома. Нажмите «На карте» и отметьте нужное здание — так время в пути и километраж будут рассчитаны точно.",
  not_found: "Адрес не найден на карте. Нажмите «На карте» и отметьте точку — так время в пути и километраж будут рассчитаны точно.",
  unavailable: "Не удалось проверить адрес. Нажмите «На карте» и отметьте точку — так время в пути и километраж будут рассчитаны точно.",
};

export default function AddressField({ value, onChange, placeholder, inputStyle, buttonStyle, mapTitle }) {
  const [mapOpen, setMapOpen] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const manual = !!value.point?.manual;

  // Проверка адреса — с задержкой после ввода; ответ на устаревший текст игнорируем.
  useEffect(() => {
    const address = value.address.trim();
    if (!address || manual || value.status !== "idle") return undefined;
    const t = setTimeout(async () => {
      onChange({ ...valueRef.current, status: "checking" });
      let res;
      try {
        res = await ridesApiFetch(`/api/v1/geocode/check?address=${encodeURIComponent(address)}`);
      } catch {
        res = { status: "unavailable" };
      }
      const cur = valueRef.current;
      if (cur.address.trim() !== address || cur.point?.manual) return;
      const at = res.lat != null ? { lat: res.lat, lng: res.lng } : null;
      onChange(res.status === "found"
        ? { ...cur, status: "found", point: { ...at, manual: false }, hint: at }
        : { ...cur, status: res.status, point: null, hint: at });
    }, CHECK_DELAY_MS);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.address, value.status, manual]);

  const setText = (address) => onChange(manual
    ? { ...value, address } // точка отмечена — текст лишь подпись
    : { ...value, address, point: null, status: "idle" });

  const needMap = addressNeedsMap(value);
  return (
    <div style={st.wrap}>
      <div style={st.row}>
        <input style={{ ...inputStyle, flex: 1, ...(needMap ? st.inputWarn : null) }} value={value.address} placeholder={placeholder}
          onChange={(e) => setText(e.target.value)} />
        <button type="button" style={{ ...buttonStyle, ...(needMap ? st.buttonWarn : null) }} onClick={() => setMapOpen(true)}>На карте</button>
      </div>
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
          onClose={() => setMapOpen(false)}
          onSelect={(address, p) => {
            onChange({ address, point: { lat: p.lat, lng: p.lng, manual: true }, status: "manual", hint: value.hint });
            setMapOpen(false);
          }}
        />
      )}
    </div>
  );
}

// Для отправки: адрес и координаты точки.
export const addressPayload = (v) => ({ address: v.address.trim(), lat: v.point?.lat, lng: v.point?.lng });

const st = {
  wrap: { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 },
  row: { display: "flex", gap: 8, flexWrap: "wrap" },
  inputWarn: { borderColor: "#e0a800", background: "#fffaf0" },
  buttonWarn: { borderColor: "#e0a800", background: "#fff3c4", fontWeight: 600 },
  muted: { fontSize: 12, color: "#777" },
  ok: { fontSize: 12, color: "#1a7f37" },
  warn: { fontSize: 12, color: "#8a5a00", background: "#fff6e0", borderRadius: 6, padding: "6px 8px", lineHeight: 1.4 },
  link: { background: "none", border: "none", color: "#1976d2", cursor: "pointer", padding: 0, fontSize: 12, textDecoration: "underline" },
};
