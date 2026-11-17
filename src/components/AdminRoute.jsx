import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";

// Гейт на клиенте — только для UX (скрыть страницу от остальных пользователей).
// Настоящая проверка доступа — на бэкенде (server/adminAuth.js), который
// сверяет Firebase ID-токен на каждый запрос к /api/admin/*, а не доверяет
// email, присланному отсюда.
const ADMIN_EMAIL = "admin@vkdev.kz";

// extraEmails — дополнительные адреса, которым открыта именно эта страница (не весь админский раздел).
export default function AdminRoute({ children, extraEmails = [] }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setChecking(false);
    });

    return () => unsubscribe();
  }, []);

  if (checking) {
    return <div style={{ padding: 30 }}>Проверка доступа...</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const allowed = user.email === ADMIN_EMAIL || extraEmails.includes((user.email || "").toLowerCase());
  if (!allowed) {
    return <Navigate to="/" replace />;
  }

  return children;
}
