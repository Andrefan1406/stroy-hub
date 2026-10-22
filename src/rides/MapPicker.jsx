// Модалка выбора адреса кликом по карте — OpenStreetMap-тайлы (бесплатно,
// без API-ключа) + обратное геокодирование через Nominatim (тоже
// бесплатный сервис OSM). Клик ставит маркер и подтягивает человекочитаемый
// адрес в поле; поле остаётся редактируемым вручную — геокодер иногда
// путает/переводит название, и водителю важнее ясный адрес, чем точный
// официальный.
import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Стандартный фикс для CRA/webpack: без него иконка маркера ищет
// картинки по относительному пути от CSS и не находит их через бандлер.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: require("leaflet/dist/images/marker-icon-2x.png"),
  iconUrl: require("leaflet/dist/images/marker-icon.png"),
  shadowUrl: require("leaflet/dist/images/marker-shadow.png"),
});

const DEFAULT_CENTER = [49.948249, 82.628443]; // Усть-Каменогорск — стартовая точка карты по умолчанию

// addressdetails=1 разбивает адрес на поля вместо одной строки
// display_name — та тащит название организации/района/области/индекс
// впереди улицы ("GEO.KZ, 3/2, проспект Победы, Стрелка, ..., 070004,
// Казахстан"), что для поля адреса заявки избыточно. Из полей берём
// только улицу и номер дома; если у точки их нет (открытая местность,
// шоссе без названия) — откатываемся на полный display_name.
async function reverseGeocode(lat, lng) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=ru&addressdetails=1`
  );
  if (!res.ok) throw new Error("geocoding failed");
  const data = await res.json();
  const a = data.address || {};
  const street = a.road || a.pedestrian || a.footway || a.street || "";
  const house = a.house_number || "";
  const short = [street, house].filter(Boolean).join(", ");
  return short || data.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

// Точка на карте обязательна: по её координатам считаются время в пути и
// километраж (сервер, routeEstimate.js), текст адреса — подпись для
// водителя. Если человек уже вписал свой текст («ул. Базовая, склад №2»),
// клик по карте его не затирает — найденный по точке адрес предлагается
// подставить отдельной кнопкой.
//   onSelect(address, { lat, lng }); initialAddress — текст из поля формы;
//   center — где открыть карту ({ lat, lng }: уже отмеченная точка или
//   найденная улица); centerIsPoint — это уже отмеченная точка (поставить маркер);
//   cityCenter — центр выбранного населённого пункта, если точки ещё нет.
export default function MapPicker({ onSelect, onClose, initialAddress = "", center = null, centerIsPoint = false, cityCenter = null, title = "Отметьте точку на карте" }) {
  const mapDivRef = useRef(null);
  const markerRef = useRef(null);
  const [address, setAddress] = useState(initialAddress);
  const [suggested, setSuggested] = useState(""); // адрес по точке, если поле уже заполнено вручную
  const [point, setPoint] = useState(centerIsPoint && center ? { lat: center.lat, lng: center.lng } : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const addressRef = useRef(initialAddress);
  addressRef.current = address;
  const autoRef = useRef(""); // последний адрес, подставленный автоматически

  useEffect(() => {
    const start = center ? [center.lat, center.lng] : cityCenter ? [cityCenter.lat, cityCenter.lng] : DEFAULT_CENTER;
    const map = L.map(mapDivRef.current).setView(start, center ? 17 : cityCenter ? 13 : 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    const placed = async (latlng) => {
      setPoint({ lat: latlng.lat, lng: latlng.lng });
      setLoading(true);
      setError("");
      try {
        const found = await reverseGeocode(latlng.lat, latlng.lng);
        const current = addressRef.current.trim();
        if (!current || current === autoRef.current) {
          autoRef.current = found;
          setAddress(found);
          setSuggested("");
        } else if (found !== current) {
          setSuggested(found);
        }
      } catch (err) {
        if (!addressRef.current.trim()) setError("Не удалось определить адрес по точке — впишите его вручную");
      } finally {
        setLoading(false);
      }
    };
    const putMarker = (latlng) => {
      if (markerRef.current) markerRef.current.setLatLng(latlng);
      else {
        markerRef.current = L.marker(latlng, { draggable: true }).addTo(map);
        markerRef.current.on("dragend", () => placed(markerRef.current.getLatLng()));
      }
    };
    if (centerIsPoint && center) putMarker(start);

    map.on("click", (e) => {
      putMarker(e.latlng);
      placed(e.latlng);
    });

    // Модалка может открыться в контейнере с ещё не финализированной
    // раскладкой (0 высоты в момент монтирования) — без этого карта иногда
    // рендерится обрезанной/серой, пока пользователь не подвигает окно.
    setTimeout(() => map.invalidateSize(), 100);

    return () => map.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 4px" }}>{title}</h3>
        <div style={s.hint}>Щёлкните по нужному зданию или въезду — маркер можно перетащить. По этой точке рассчитываются время в пути и километраж.</div>
        <div ref={mapDivRef} style={s.map} />
        {error && <div style={s.error}>{error}</div>}
        <label style={s.label}>
          Адрес для водителя
          <input
            style={s.input}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={loading ? "Определяем адрес..." : "Например: ул. Базовая, склад №2, въезд со двора"}
          />
        </label>
        {suggested && (
          <div style={s.suggest}>
            По точке на карте: {suggested}{" "}
            <button type="button" style={s.linkButton} onClick={() => { setAddress(suggested); autoRef.current = suggested; setSuggested(""); }}>Подставить</button>
          </div>
        )}
        <div style={s.actions}>
          <button type="button" style={s.secondaryButton} onClick={onClose}>Отмена</button>
          <button
            type="button"
            style={s.primaryButton}
            disabled={!point || !address.trim()}
            title={!point ? "Сначала отметьте точку на карте" : undefined}
            onClick={() => onSelect(address.trim(), point)}
          >
            {point ? "Использовать эту точку" : "Отметьте точку на карте"}
          </button>
        </div>
      </div>
    </div>
  );
}

const s = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 },
  modal: { background: "#fff", borderRadius: "10px", padding: "16px", width: "560px", maxWidth: "92vw", boxSizing: "border-box" },
  map: { height: "320px", maxWidth: "100%", borderRadius: "8px", marginBottom: "10px", marginTop: "8px" },
  hint: { fontSize: "12px", color: "#555", lineHeight: 1.4 },
  suggest: { fontSize: "12px", color: "#555", marginTop: "6px" },
  linkButton: { background: "none", border: "none", color: "#1976d2", cursor: "pointer", padding: 0, fontSize: "12px", textDecoration: "underline" },
  label: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", color: "#444" },
  input: { padding: "8px 10px", borderRadius: "6px", border: "1px solid #ccc", fontSize: "14px", width: "100%", boxSizing: "border-box" },
  error: { background: "#fff0f0", color: "#c00", borderRadius: "6px", padding: "6px 10px", marginBottom: "8px", fontSize: "12px" },
  actions: { display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: "8px", marginTop: "14px" },
  primaryButton: { background: "#1976d2", color: "#fff", border: "none", borderRadius: "6px", padding: "8px 16px", cursor: "pointer", fontSize: "13px", fontWeight: 600 },
  secondaryButton: { background: "#fff", border: "1px solid #ccc", borderRadius: "6px", padding: "8px 14px", cursor: "pointer", fontSize: "13px" },
};
