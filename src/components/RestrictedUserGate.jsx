// Общесайтовый гейт для пользователей с доступом к одной странице (см. restrictedAccess.js).
// Оборачивает <Routes> целиком в App.js, поэтому прямой переход по ссылке или ввод другого адреса
// не даёт «выйти»: любой путь, кроме /login и их страницы, ведёт на неё. Остальные пользователи гейта не замечают.
import React, { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";
import { restrictedHome } from "../restrictedAccess";

export default function RestrictedUserGate({ children }) {
  const location = useLocation();
  const [user, setUser] = useState(undefined); // undefined = проверяется, null = не залогинен

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  if (user === undefined) return <div style={{ padding: 30 }}>Проверка доступа...</div>;

  const home = restrictedHome(user?.email);
  if (home && location.pathname !== "/login" && location.pathname !== home) {
    return <Navigate to={home} replace />;
  }
  return children;
}
