import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import { canUsePto } from "../pto/access";

// Гейт на клиенте — только для UX: остальные пользователи уходят на главную и
// не видят страницу. Настоящая проверка — на бэкенде (server/pto/access.js):
// каждый /api/pto/* проверяет Firebase ID-токен и отвечает 403.
export default function PtoRoute({ children }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setChecking(false);
    });
    return () => unsubscribe();
  }, []);

  if (checking) return <div style={{ padding: 30 }}>Проверка доступа...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!canUsePto(user.email)) return <Navigate to="/" replace />;
  return children;
}
