// Фабрика сокета для страниц системы поездок — каждая страница открывает
// свой сокет в useEffect и закрывает при размонтировании. auth передан
// функцией (не объектом), чтобы socket.io-client запрашивал свежий
// Firebase ID-токен на каждую попытку (пере)подключения, а не использовал
// протухший токен, полученный при первом рендере.
import { io } from "socket.io-client";
import { getAuth } from "firebase/auth";
import { RIDES_API_URL } from "./api";
import { getTelegramSession, isTelegramMiniApp } from "./telegramSession";

export function createRidesSocket() {
  return io(RIDES_API_URL, {
    auth: async (cb) => {
      if (isTelegramMiniApp()) return cb({ token: getTelegramSession().token });
      const user = getAuth().currentUser;
      if (!user) return cb({});
      const token = await user.getIdToken();
      cb({ token });
    },
  });
}
