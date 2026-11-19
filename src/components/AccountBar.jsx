// Логин и кнопка выхода в правом верхнем углу — на каждой странице сайта
// (подключён один раз в App.js, а не в каждой странице). У админа логин —
// ссылка в личный кабинет (/admin). position: fixed — страницы свёрстаны
// по-разному (светлые формы, тёмный финплан), а в общем потоке блок пришлось
// бы встраивать в каждую; подложка делает его читаемым на любом фоне.
import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { TbLogout } from "react-icons/tb";
import { auth } from "../firebase";
import { restrictedHome } from "../restrictedAccess";
import { useConfirm } from "./ConfirmDialog";
import { ATTENTION_LABELS, useDrillingAttention } from "../pages/drilling/useDrillingCounter";

const ADMIN_EMAIL = "admin@vkdev.kz";

export default function AccountBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState(auth.currentUser?.email?.toLowerCase() || "");
  const { total: drillingCount, items: drillingItems } = useDrillingAttention();
  const [open, setOpen] = useState(false);
  const barRef = useRef(null);
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => onAuthStateChanged(auth, (user) => setEmail(user?.email?.toLowerCase() || "")), []);

  // Список заявок у логина закрывается кликом мимо, по Esc и при переходе на другую страницу.
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (barRef.current && !barRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // В Telegram Mini App (/tg/*) вход — через Telegram, не через этот логин.
  if (!email || location.pathname === "/login" || location.pathname.startsWith("/tg")) return null;

  const login = email.split("@")[0];

  const handleLogout = async () => {
    if (!(await confirm({ title: "Выйти из аккаунта?", confirmLabel: "Выйти" }))) return;
    await signOut(auth);
    navigate("/login");
  };

  return (
    <div style={styles.bar} ref={barRef} className="no-print">
      {restrictedHome(email) ? (
        <span style={styles.accountEmail}>{login}</span>
      ) : (
        <>
          <button type="button" onClick={() => navigate(email === ADMIN_EMAIL ? "/admin" : "/account")} style={styles.adminLink} title="Личный кабинет">
            {login}
          </button>
          {drillingCount > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              style={styles.badge}
              aria-expanded={open}
              aria-haspopup="true"
              aria-label={`Заявки, ждущие вашего внимания: ${drillingCount}`}
              title="Заявки на бурение и резку, ждущие вашего внимания"
            >
              {drillingCount}
            </button>
          )}
        </>
      )}
      <button type="button" onClick={handleLogout} style={styles.logoutIconBtn} title="Выход" aria-label="Выход">
        <TbLogout aria-hidden="true" />
      </button>
      {confirmDialog}
      {open && (
        <div style={styles.popover} role="menu" aria-label="Заявки на бурение и резку">
          <div style={styles.popoverTitle}>Заявки на бурение и резку</div>
          {drillingItems.map((it) => (
            <button key={it.id} type="button" role="menuitem" style={styles.popoverItem} onClick={() => navigate(`/drilling-requests/${it.id}`)}>
              <span style={styles.popoverKind}>{ATTENTION_LABELS[it.kind]}</span>
              <span>№ {it.id} · {it.places.join("; ")}</span>
            </button>
          ))}
          <button type="button" style={styles.popoverAll} onClick={() => navigate("/drilling-requests")}>Все заявки →</button>
        </div>
      )}
    </div>
  );
}

// Цвета и шрифт — как у главной (HomePage.module.css): акцент цвета логотипа,
// контур, видимый на солнце. top учитывает вырез iPhone (safe-area), иначе
// кнопки уходят под строку статуса и не нажимаются.
const BRAND = "#485875";
const styles = {
  bar: {
    position: "fixed",
    top: "calc(env(safe-area-inset-top, 0px) + var(--account-bar-top, 4px))",
    right: "12px",
    zIndex: 50, // ниже модальных окон (100-200), чтобы не перекрывать их
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "0 2px 0 6px",
    borderRadius: "10px",
    border: "1px solid #939ba7",
    background: "rgba(255, 255, 255, 0.95)",
    fontFamily: "inherit",
  },
  accountEmail: {
    color: "#4b5563",
    fontSize: "14px",
    fontWeight: "500",
  },
  adminLink: {
    minHeight: "32px",
    background: "none",
    border: "none",
    color: BRAND,
    cursor: "pointer",
    font: "inherit",
    fontSize: "14px",
    fontWeight: "600",
    padding: "0 6px",
    textDecoration: "underline",
    textUnderlineOffset: "3px",
  },
  badge: {
    minWidth: "24px",
    height: "24px",
    margin: "0 2px",
    padding: "0 6px",
    borderRadius: "12px",
    border: "none",
    background: "#d92d20",
    color: "#fff",
    fontSize: "13px",
    fontWeight: "700",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  popover: {
    position: "absolute",
    top: "calc(100% + 6px)",
    right: 0,
    width: "min(340px, calc(100vw - 24px))",
    maxHeight: "60vh",
    overflowY: "auto",
    background: "#fff",
    border: "1px solid #939ba7",
    borderRadius: "10px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    padding: "6px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  popoverTitle: { padding: "6px 8px", fontSize: "12px", fontWeight: "700", color: "#4b5563", textTransform: "uppercase" },
  popoverItem: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    textAlign: "left",
    padding: "8px",
    border: "none",
    borderRadius: "8px",
    background: "none",
    cursor: "pointer",
    font: "inherit",
    fontSize: "14px",
    color: "#1f2937",
  },
  popoverKind: { fontSize: "12px", fontWeight: "700", color: "#d92d20" },
  popoverAll: { padding: "8px", border: "none", background: "none", cursor: "pointer", font: "inherit", fontSize: "14px", fontWeight: "600", color: BRAND, textAlign: "left" },
  logoutIconBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "36px",
    minHeight: "32px",
    background: "none",
    border: "none",
    color: BRAND,
    cursor: "pointer",
    fontSize: "20px",
    lineHeight: "1",
    padding: "0 4px",
  },
};
