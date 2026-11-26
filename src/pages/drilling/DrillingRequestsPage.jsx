// Список заявок на бурение и резку: «Мои» (автор), «Входящие» (исполнители и главный
// инженер) и «Все» (админ, главный инженер). Заявки, ждущие ответа, можно согласовать,
// принять или отклонить прямо в списке — по одной или несколько сразу (галочки).
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";
import DrillingNav from "./DrillingNav";
import RejectDialog from "./RejectDialog";
import { useConfirm } from "../../components/ConfirmDialog";
import { acceptRequest, fetchMe, fetchRequests, rejectRequest, STATUS_LABELS, fmtDateTime } from "./drillingApi";

// С какой вкладки начать: админ — «Все», главный инженер и исполнители — «Входящие», остальные — «Мои».
function defaultTab(me) {
  if (me.isAdmin) return "all";
  if (me.isChief || me.companies.length) return "inbox";
  return "mine";
}

const acceptLabel = (status) => (status === "engineer" ? "Согласовать" : "Принять");

const DrillingRequestsPage = () => {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState(null); // выбирается после загрузки профиля (см. defaultTab)
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [picked, setPicked] = useState(() => new Set()); // id отмеченных заявок
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(null); // массив id, по которым вводят причину отказа
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async (scope) => {
    try {
      const [m, list] = await Promise.all([fetchMe(), fetchRequests(scope)]);
      setMe(m);
      setRequests(list);
      // отметки только у тех заявок, что всё ещё ждут ответа
      setPicked((cur) => new Set([...cur].filter((id) => list.some((r) => r.id === id && r.waitingForMe))));
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    fetchMe().then((m) => setTab((cur) => cur || defaultTab(m))).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!tab) return undefined;
    setRequests(null);
    setPicked(new Set());
    load(tab);
    const timer = setInterval(() => load(tab), 30000); // новые заявки и ответы подтягиваются сами
    return () => clearInterval(timer);
  }, [tab, load]);

  // «Мои» — у тех, кто подаёт заявки; «Входящие» — у исполнителей и главного инженера (ждут их ответа);
  // «Все» — у админа и главного инженера.
  const tabs = [];
  if (me?.isAdmin || me?.isChief) tabs.push({ key: "all", label: "Все заявки" });
  if (me?.companies.length || me?.isChief) tabs.push({ key: "inbox", label: "Входящие", count: me.counters.inbox });
  if (me?.canSubmit) tabs.push({ key: "mine", label: "Мои заявки", count: me.counters.mine });

  const waiting = useMemo(() => (requests || []).filter((r) => r.waitingForMe), [requests]);
  const toggle = (id) => setPicked((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allPicked = waiting.length > 0 && waiting.every((r) => picked.has(r.id));
  const pickedList = waiting.filter((r) => picked.has(r.id));

  // Выполняет действие по списку заявок по очереди; сообщает, что получилось, а что нет.
  const runBulk = async (ids, fn, doneWord) => {
    setBusy(true);
    setError("");
    setNotice("");
    const failed = [];
    let ok = 0;
    for (const id of ids) {
      try {
        await fn(id);
        ok += 1;
      } catch (err) {
        failed.push(`№ ${id}: ${err.message}`);
      }
    }
    setBusy(false);
    setRejecting(null);
    if (ok) setNotice(`${doneWord}: ${ok}.`);
    if (failed.length) setError(`Не удалось: ${failed.join("; ")}`);
    await load(tab);
  };

  const acceptOne = async (r) => {
    const ok = await confirm({
      title: r.status === "engineer" ? `Согласовать заявку № ${r.id}?` : `Принять заявку № ${r.id} в работу?`,
      confirmLabel: acceptLabel(r.status),
    });
    if (ok) runBulk([r.id], (id) => acceptRequest(id), r.status === "engineer" ? "Согласовано" : "Принято");
  };

  const acceptPicked = async () => {
    const stages = new Set(pickedList.map((r) => r.status === "engineer"));
    const word = stages.size === 2 ? "Согласовать / принять" : stages.has(true) ? "Согласовать" : "Принять";
    const ok = await confirm({ title: `${word} выбранные заявки (${pickedList.length})?`, confirmLabel: word });
    if (ok) runBulk(pickedList.map((r) => r.id), (id) => acceptRequest(id), stages.size === 2 ? "Обработано" : stages.has(true) ? "Согласовано" : "Принято");
  };

  const renderRow = (r) => (
    <div key={r.id} className={`${styles.rowWrap} ${r.waitingForMe ? styles.rowWrapWaiting : ""}`}>
      <div className={styles.rowTop}>
        {r.waitingForMe ? (
          <input type="checkbox" className={styles.pick} checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Выбрать заявку № ${r.id}`} />
        ) : <span />}
        <Link to={`/drilling-requests/${r.id}`} className={styles.rowLink}>
          <span className={styles.rowNum}>№ {r.id}</span>
          <span className={styles.rowMain}>
            <div className={styles.rowPlaces}>{r.places.join("; ")}{r.itemsCount > r.places.length ? "…" : ""}</div>
            {r.works?.map((w) => <div key={w} className={styles.rowWorks}>{w}</div>)}
            {r.itemsCount > (r.works?.length || 0) && <div className={styles.rowWorks}>…и ещё строк: {r.itemsCount - r.works.length}</div>}
            <div className={styles.rowMeta}>
              {fmtDateTime(r.createdAt)} · {r.initiator} · строк: {r.itemsCount}{r.attachmentsCount > 0 ? ` · 📎 ${r.attachmentsCount}` : ""}{r.round > 1 ? ` · круг ${r.round}` : ""}
            </div>
          </span>
          <span className={`${styles.badge} ${styles[`st_${r.status}`]}`}>{STATUS_LABELS[r.status]}</span>
        </Link>
      </div>
      <div className={styles.rowActions}>
        <Link to={`/drilling-requests/${r.id}`} className={styles.btnOpen}>Открыть заявку →</Link>
        {r.waitingForMe && (
          <>
            <button className={styles.btnOk} disabled={busy} onClick={() => acceptOne(r)}>{acceptLabel(r.status)}</button>
            <button className={styles.btnSmallDanger} disabled={busy} onClick={() => setRejecting([r.id])}>Отклонить</button>
          </>
        )}
      </div>
    </div>
  );

  const rest = (requests || []).filter((r) => !r.waitingForMe);

  return (
    <div className={css.page}>
      <div className={css.content}>
        <DrillingNav />
        <div className={styles.head}>
          <h1 className={css.title}>Заявки на бурение и резку</h1>
        </div>

        <div className={styles.tabs} role="tablist">
          {tabs.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`${styles.tab} ${tab === t.key ? styles.tabActive : ""}`}>
              {t.label}
              {t.count > 0 && <span className={styles.count}>{t.count}</span>}
            </button>
          ))}
        </div>

        {error && <div className={styles.error} role="alert">{error}</div>}
        {notice && <div className={styles.ok} role="status">{notice}</div>}
        {requests === null && !error && <div className={styles.empty}>Загрузка…</div>}

        {pickedList.length > 0 && (
          <div className={styles.bulkBar}>
            <b>Выбрано: {pickedList.length}</b>
            <button className={styles.btnOk} disabled={busy} onClick={acceptPicked}>
              {pickedList.every((r) => r.status === "engineer") ? "Согласовать выбранные" : pickedList.every((r) => r.status !== "engineer") ? "Принять выбранные" : "Согласовать / принять выбранные"}
            </button>
            <button className={styles.btnSmallDanger} disabled={busy} onClick={() => setRejecting(pickedList.map((r) => r.id))}>Отклонить выбранные</button>
            <button className={css.btnGhost} style={{ minHeight: 40, marginRight: 0 }} onClick={() => setPicked(new Set())}>Снять выбор</button>
          </div>
        )}

        {requests && tab === "inbox" ? (
          <>
            <div className={styles.sectionHead}>
              Ждут вашего ответа
              {waiting.length > 0 && <span className={styles.count}>{waiting.length}</span>}
              {waiting.length > 1 && (
                <label style={{ marginLeft: "auto", fontWeight: 500, fontSize: 14, display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" className={styles.pick} checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(waiting.map((r) => r.id)))} />
                  Выбрать все
                </label>
              )}
            </div>
            {waiting.length === 0 && <div className={styles.empty}>Новых заявок, ждущих вашего ответа, нет.</div>}
            <div className={styles.list}>{waiting.map(renderRow)}</div>
            <div className={styles.sectionHead}>Принятые вашей компанией</div>
            {rest.length === 0 && <div className={styles.empty}>Пока нет.</div>}
            <div className={styles.list}>{rest.map(renderRow)}</div>
          </>
        ) : (
          <>
            {requests?.length === 0 && <div className={styles.empty}>Заявок нет.</div>}
            {waiting.length > 1 && (
              <label style={{ display: "flex", gap: 6, alignItems: "center", margin: "6px 0", fontSize: 14 }}>
                <input type="checkbox" className={styles.pick} checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(waiting.map((r) => r.id)))} />
                Выбрать все, ждущие вашего ответа ({waiting.length})
              </label>
            )}
            <div className={styles.list}>{requests?.map(renderRow)}</div>
          </>
        )}
      </div>
      {confirmDialog}
      {rejecting && (
        <RejectDialog busy={busy} count={rejecting.length} onCancel={() => setRejecting(null)}
          onSubmit={(reason) => runBulk(rejecting, (id) => rejectRequest(id, reason), "Отклонено")} />
      )}
    </div>
  );
};

export default DrillingRequestsPage;
