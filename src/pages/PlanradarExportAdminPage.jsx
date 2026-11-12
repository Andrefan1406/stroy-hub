// Личный кабинет админа → «Замечания PlanRadar». Выбор начальной и конечной
// даты (по дате создания замечания) и объекта, выгрузка в Excel. Выгрузка по
// всем объектам идёт минуты (лимит API PlanRadar — 30 запросов в минуту), поэтому
// сервер делает её в фоне, а страница показывает ход и скачивает файл по готовности.
// Бэкенд: server/planradarExport.js.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  downloadPlanradarExport,
  fetchPlanradarExport,
  fetchPlanradarProjects,
  startPlanradarExport,
} from "./planradarExportApi";

const pad = (n) => String(n).padStart(2, "0");
const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const firstOfMonth = () => {
  const d = new Date();
  return toIso(new Date(d.getFullYear(), d.getMonth(), 1));
};
const fmtDate = (iso) => (iso ? iso.split("-").reverse().join(".") : "");

const PlanradarExportAdminPage = () => {
  const navigate = useNavigate();
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(() => toIso(new Date()));
  const [projects, setProjects] = useState([]);
  const [selected, setSelected] = useState(() => new Set()); // id отмеченных объектов
  const [search, setSearch] = useState("");
  const [withPhotos, setWithPhotos] = useState(true);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const pollRef = useRef(null);
  const downloadedRef = useRef(null);

  useEffect(() => {
    fetchPlanradarProjects()
      .then((list) => {
        setProjects(list);
        setSelected(new Set(list.map((p) => p.id))); // по умолчанию отмечены все
      })
      .catch((err) => setError(err.message));
    return () => clearInterval(pollRef.current);
  }, []);

  const download = useCallback(async (j) => {
    try {
      await downloadPlanradarExport(j.id, j.filename);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // Пока выгрузка идёт — опрашиваем ход раз в 2 секунды; по готовности скачиваем файл.
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!job || job.status !== "running") return undefined;
    pollRef.current = setInterval(async () => {
      try {
        const next = await fetchPlanradarExport(job.id);
        setJob(next);
        if (next.status === "done" && downloadedRef.current !== next.id) {
          downloadedRef.current = next.id;
          download(next);
        }
      } catch (err) {
        setError(err.message);
        clearInterval(pollRef.current);
      }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [job, download]);

  const datesOk = from && to && from <= to;
  const running = job?.status === "running";
  const query = search.trim().toLowerCase();
  const visible = projects.filter((p) => !query || p.name.toLowerCase().includes(query));
  const allSelected = projects.length > 0 && selected.size === projects.length;
  const canStart = datesOk && selected.size > 0;

  const toggle = (id) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  // «Все»/«Снять» действуют на показанные (после поиска) объекты
  const setVisible = (checked) => setSelected((cur) => {
    const next = new Set(cur);
    visible.forEach((p) => (checked ? next.add(p.id) : next.delete(p.id)));
    return next;
  });

  const handleStart = async () => {
    if (starting || running || !canStart) return;
    setStarting(true);
    setError("");
    try {
      setJob(await startPlanradarExport({ from, to, projectIds: allSelected ? null : [...selected], withPhotos }));
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  };

  const progress = job?.progress;
  const percent = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div style={s.page}>
      <div style={s.header}>
        <button onClick={() => navigate("/admin")} style={s.back}>← Назад</button>
        <h1 style={s.title}>Замечания PlanRadar</h1>
      </div>

      <p style={s.intro}>
        Выберите период — в Excel попадут все замечания, созданные в PlanRadar с начальной по конечную дату
        включительно (по времени Алматы). По всем объектам выгрузка занимает несколько минут: PlanRadar
        ограничивает число запросов, страницу можно не закрывать — файл скачается сам.
      </p>

      {error && <div style={s.errorBox}>{error}</div>}

      <div style={s.card}>
        <div style={s.fields}>
          <label style={s.field}>
            <span style={s.label}>С даты</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={s.input} disabled={running} />
          </label>
          <label style={s.field}>
            <span style={s.label}>По дату</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={s.input} disabled={running} />
          </label>
        </div>

        {!datesOk && from && to && <div style={s.warn}>Начальная дата позже конечной.</div>}

        <div style={s.field}>
          <div style={s.projectsHead}>
            <span style={s.label}>Объекты: отмечено {selected.size} из {projects.length}</span>
            <span style={s.headActions}>
              <button type="button" onClick={() => setVisible(true)} style={s.link} disabled={running}>Отметить все</button>
              <button type="button" onClick={() => setVisible(false)} style={s.link} disabled={running}>Снять все</button>
            </span>
          </div>
          <input
            type="search"
            placeholder="Найти объект…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...s.input, marginBottom: "6px" }}
          />
          <div style={s.projectList}>
            {visible.map((p) => (
              <label key={p.id} style={s.projectRow}>
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} disabled={running} />
                <span>{p.name}</span>
              </label>
            ))}
            {!visible.length && <div style={s.empty}>{projects.length ? "Ничего не найдено" : "Загрузка списка объектов…"}</div>}
          </div>
          {projects.length > 0 && selected.size === 0 && <div style={s.warn}>Отметьте хотя бы один объект.</div>}
        </div>

        <label style={s.photoRow}>
          <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} disabled={running} />
          <span>
            Вытаскивать фото к замечаниям
            <span style={s.hint}>
              {" "}— отдельно фото «до» (при создании замечания) и «после» (подтверждение устранения): в столбцах «Фото до» и «Фото после» первые 4 каждого вида лежат в одной ячейке сеткой 2×2, общее число — в столбцах «Фото до, шт.» и «Фото после, шт.».
              {withPhotos ? " Выгрузка дольше: около 2,5 секунды на каждое замечание." : ""}
            </span>
          </span>
        </label>

        <button
          onClick={handleStart}
          disabled={starting || running || !canStart}
          style={{ ...s.btn, ...(starting || running || !canStart ? s.btnDisabled : null) }}
        >
          {running ? "Идёт выгрузка…" : starting ? "Запуск…" : "Выгрузить в Excel"}
        </button>

        {running && (
          <div style={s.runningBox}>
            <div>
              Объект {Math.min(progress.done + 1, progress.total)} из {progress.total}
              {progress.current ? `: ${progress.current}` : ""}
            </div>
            <div style={s.bar}><div style={{ ...s.barFill, width: `${percent}%` }} /></div>
          </div>
        )}

        {job?.status === "done" && (
          <div style={s.okBox}>
            Готово: замечаний за {fmtDate(job.from)} — {fmtDate(job.to)}: <b>{job.count}</b>. Файл скачан.{" "}
            <button onClick={() => download(job)} style={s.link}>Скачать ещё раз</button>
            {job.withPhotos && job.photoFailures > 0 && (
              <div style={s.warn}>Не удалось получить фото: {job.photoFailures} шт. — запустите выгрузку ещё раз, если они нужны.</div>
            )}
            {job.errors?.length > 0 && (
              <div style={s.warn}>
                По объектам не удалось получить данные (они есть на листе «Ошибки»): {job.errors.map((e) => e.project).join(", ")}.
                Запустите выгрузку ещё раз.
              </div>
            )}
          </div>
        )}
        {job?.status === "error" && <div style={s.errorBox}>Выгрузка не удалась: {job.error}</div>}
      </div>
    </div>
  );
};

const s = {
  page: { padding: "24px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: "720px", margin: "0 auto" },
  header: { display: "flex", alignItems: "center", gap: "16px", marginBottom: "16px" },
  back: { background: "none", border: "1px solid #ddd", borderRadius: "6px", padding: "6px 12px", cursor: "pointer" },
  title: { margin: 0, fontSize: "22px" },
  intro: { fontSize: "14px", color: "#555", lineHeight: 1.5, marginBottom: "16px" },

  card: { background: "#fff", borderRadius: "12px", padding: "18px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)", display: "flex", flexDirection: "column", gap: "14px" },
  fields: { display: "flex", flexWrap: "wrap", gap: "14px" },
  field: { display: "flex", flexDirection: "column", gap: "4px" },
  label: { fontSize: "12px", color: "#888" },
  input: { padding: "8px 10px", border: "1px solid #ccc", borderRadius: "8px", fontSize: "14px", background: "#fff" },

  btn: { background: "#1a5fb4", color: "#fff", border: "none", borderRadius: "8px", padding: "12px 16px", fontSize: "14px", fontWeight: 600, cursor: "pointer" },
  btnDisabled: { background: "#c8c8c8", cursor: "default" },
  link: { background: "none", border: "none", color: "#1a5fb4", textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: "13px" },

  runningBox: { background: "#eef5ff", color: "#1a5fb4", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", display: "flex", flexDirection: "column", gap: "8px" },
  bar: { height: "6px", background: "#cfe0fb", borderRadius: "3px", overflow: "hidden" },
  barFill: { height: "100%", background: "#1a5fb4", transition: "width 0.4s" },
  okBox: { background: "#e7f6ec", color: "#1a7f37", borderRadius: "8px", padding: "10px 12px", fontSize: "13px" },
  errorBox: { background: "#fdecec", color: "#c0392b", borderRadius: "8px", padding: "10px 12px", fontSize: "13px", marginBottom: "8px" },
  photoRow: { display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "14px", cursor: "pointer" },
  hint: { color: "#777", fontSize: "12px" },
  warn: { color: "#8a5a00", fontSize: "13px", marginTop: "6px" },
  projectsHead: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "6px" },
  headActions: { display: "flex", gap: "14px" },
  projectList: { maxHeight: "260px", overflowY: "auto", border: "1px solid #e3e3e3", borderRadius: "8px", padding: "6px 10px", display: "flex", flexDirection: "column", gap: "2px" },
  projectRow: { display: "flex", alignItems: "center", gap: "8px", fontSize: "14px", padding: "4px 0", cursor: "pointer" },
  empty: { color: "#888", fontSize: "13px", padding: "8px 0" },
};

export default PlanradarExportAdminPage;
