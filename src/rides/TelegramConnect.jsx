// «Подключить Telegram» на страницах пассажира и диспетчера: одноразовая
// ссылка на бота (server/rides/telegramRouter.js). У водителя такой же блок
// встроен в DriverDashboardPage.jsx (там ещё и сокет-событие о привязке).
// Пока ссылка открыта, страница раз в несколько секунд спрашивает сервер,
// подключился ли бот, — отдельный сокет ради этого не нужен.
import React, { useCallback, useEffect, useState } from "react";
import { ridesApiDelete, ridesApiFetch, ridesApiPost } from "./api";
import { isTelegramMiniApp } from "./telegramSession";
import ConfirmDialog from "./ConfirmDialog";

const POLL_MS = 4000;

export default function TelegramConnect({ hint }) {
  const [info, setInfo] = useState(null); // { enabled, username, linked }
  const [link, setLink] = useState(null); // { url, expiresAt }
  const [error, setError] = useState("");
  const [confirmingOff, setConfirmingOff] = useState(false);

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

  // Подтверждение — своим окном: window.confirm в Android-приложении молча
  // возвращает false. Ошибку показывает само окно (ConfirmDialog).
  const disconnect = async () => {
    await ridesApiDelete("/api/v1/telegram/link");
    setInfo((prev) => ({ ...prev, linked: false }));
    setConfirmingOff(false);
  };

  return (
    <div style={s.box}>
      {info.linked ? (
        <>
          <span>✓ Telegram подключён — уведомления приходят в бот @{info.username}.</span>
          <button type="button" style={s.linkButton} onClick={() => setConfirmingOff(true)}>Отключить</button>
        </>
      ) : link ? (
        <>
          <a href={link.url} target="_blank" rel="noreferrer" style={s.primaryLink}>Открыть Telegram</a>
          <span style={s.muted}>и нажмите «Start». Ссылка одноразовая, действует 15 минут.</span>
        </>
      ) : (
        <>
          <span>{hint}</span>
          <button type="button" style={s.secondaryButton} onClick={connect}>Подключить Telegram</button>
        </>
      )}
      {error && <span style={s.error}>{error}</span>}
      {confirmingOff && (
        <ConfirmDialog
          title="Отключить Telegram?"
          text="Уведомления перестанут приходить в бот."
          confirmLabel="Отключить"
          cancelLabel="Оставить"
          onConfirm={disconnect}
          onClose={() => setConfirmingOff(false)}
        />
      )}
    </div>
  );
}

const s = {
  box: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", background: "#f4f9ff", border: "1px solid #cfe3f7", borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px" },
  linkButton: { background: "none", border: "none", padding: "10px 0", color: "#1565c0", textDecoration: "underline", cursor: "pointer", fontSize: "14px" },
  // Фирменный голубой Telegram (#229ED9) с белым текстом — 3:1, мало для
  // текста; затемнённый #17739f — 5,3:1.
  primaryLink: { display: "inline-flex", alignItems: "center", minHeight: "44px", background: "#17739f", color: "#fff", borderRadius: "8px", padding: "0 16px", fontSize: "15px", fontWeight: 600, textDecoration: "none", boxSizing: "border-box" },
  secondaryButton: { minHeight: "44px", background: "#fff", border: "1px solid #8c8c8c", borderRadius: "8px", padding: "0 16px", cursor: "pointer", fontSize: "15px" },
  muted: { color: "#666", fontSize: "13px" },
  error: { color: "#c00", fontSize: "13px" },
};
