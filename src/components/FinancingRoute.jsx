import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";

// Список — только для UX (скрыть кнопку и страницу). Настоящая проверка
// доступа — в services/financing-api/auth.py (Firebase ID-токен на каждый запрос).
export const FINANCING_PLAN_EMAILS = [
  "admin@vkdev.kz",
  "v.titarenko@vkdevgroup.kz",
];

export const canSeeFinancingPlan = (email) =>
  !!email && FINANCING_PLAN_EMAILS.includes(email.toLowerCase());

export default function FinancingRoute({ children }) {
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

  if (!canSeeFinancingPlan(user.email)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
