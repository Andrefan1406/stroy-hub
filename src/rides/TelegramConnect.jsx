// «Подключить Telegram» на страницах пассажира и диспетчера: одноразовая
// ссылка на бота (server/rides/telegramRouter.js). У водителя такой же блок
// встроен в DriverDashboardPage.jsx (там ещё и сокет-событие о привязке).
// Пока ссылка открыта, страница раз в несколько секунд спрашивает сервер,
// подключился ли бот, — отдельный сокет ради этого не нужен.
import React, { useCallback, useEffect, useState } from "react";
import { ridesApiDelete, ridesApiFetch, ridesApiPost } from "./api";
import { isTelegramMiniApp } from "./telegramSession";

const POLL_MS = 4000;

export default function TelegramConnect({ hint }) {
  const [info, setInfo] = useState(null); // { enabled, username, linked }
  const [link, setLink] = useState(null); // { url, expiresAt }
  const [error, setError] = useState("");

  const load = useCallback(() => ridesApiFetch("/api/v1/telegram/me").then(setInfo).catch(() => setInfo(null)), []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!link) return undefined;
    const t = setInterval(async () => {
      const next = await ridesApiFetch("/api/v1/telegram/me").catch(() => null);
      if (!next) return;
      setInfo(next);
      if (next.linked || Date.parse(link.expiresAt) < Date.now()) setLink(null);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [link]);

  if (!info?.enabled || isTelegramMiniApp()) return null;

  const connect = async () => {
    setError("");
    try {
      setLink(await ridesApiPost("/api/v1/telegram/link"));
    } catch (err) {
      setError(err.message || "Не удалось получить ссылку для Telegram");
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Отключить Telegram? Уведомления перестанут приходить в бот.")) return;
    try {
      await ridesApiDelete("/api/v1/telegram/link");
      setInfo((prev) => ({ ...prev, linked: false }));
    } catch (err) {
      setError(err.message || "Не удалось отключить Telegram");
    }
  };

  return (
    <div style={s.box}>
      {info.linked ? (
        <>
          <span>✓ Telegram подключён — уведомления приходят в бот @{info.username}.</span>
          <button style={s.linkButton} onClick={disconnect}>Отключить</button>
        </>
      ) : link ? (
        <>
          <a href={link.url} target="_blank" rel="noreferrer" style={s.primaryLink}>Открыть Telegram</a>
          <span style={s.muted}>и нажмите «Start». Ссылка одноразовая, действует 15 минут.</span>
        </>
      ) : (
        <>
          <span>{hint}</span>
          <button style={s.secondaryButton} onClick={connect}>Подключить Telegram</button>
        </>
      )}
      {error && <span style={s.error}>{error}</span>}
    </div>
  );
}

const s = {
  box: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", background: "#f4f9ff", border: "1px solid #cfe3f7", borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px" },
  linkButton: { background: "none", border: "none", padding: 0, color: "#1976d2", textDecoration: "underline", cursor: "pointer", fontSize: "13px" },
  primaryLink: { background: "#229ED9", color: "#fff", borderRadius: "6px", padding: "8px 14px", fontSize: "13px", fontWeight: 600, textDecoration: "none" },
  secondaryButton: { background: "#fff", border: "1px solid #ccc", borderRadius: "6px", padding: "8px 14px", cursor: "pointer", fontSize: "13px" },
  muted: { color: "#888", fontSize: "13px" },
  error: { color: "#c00", fontSize: "13px" },
};
