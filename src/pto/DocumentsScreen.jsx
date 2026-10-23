// Главный экран ПТО: загрузка PDF раздела с привязкой к объекту/позиции/дому
// (справочники сайта — те же, что в заявке на бетон) и список загруженных
// документов. Пока документ разбирается, список сам обновляется.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { objectCategoryOptions, objectPositionOptions, positionBlockOptions } from "../data/constructionData";
import { ptoDelete, ptoGet, ptoUpload } from "./api";
import { DOC_STATUS, formatDate } from "./format";
import { s } from "./styles";

const SECTION_DEFAULT = "КЖ";

function UploadForm({ sections, onUploaded }) {
  const [form, setForm] = useState({ section: SECTION_DEFAULT, category: "", object: "", position: "", block: "" });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const objects = objectCategoryOptions[form.category] || [];
  const positions = objectPositionOptions[form.object] || [];
  const blocks = positionBlockOptions[form.position] || [];

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (!form.object) return setError("Выберите объект");
    if (positions.length && !form.position) return setError("Выберите позицию");
    if (blocks.length && !form.block) return setError("Выберите дом (блок)");
    if (!file) return setError("Выберите PDF-файл раздела");
    if (!/\.pdf$/i.test(file.name)) return setError("Нужен файл PDF");
    setBusy(true);
    try {
      const { id } = await ptoUpload(file, form);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      onUploaded(id);
    } catch (err) {
      setError(err.message || "Не удалось загрузить файл");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={s.card}>
      <h3 style={s.cardTitle}>Загрузить раздел проекта</h3>
      {error && <div style={s.error}>{error}</div>}
      <div style={s.formGrid}>
        <label style={s.label}>Раздел
          <select style={s.input} value={form.section} onChange={(e) => set({ section: e.target.value })}>
            {sections.map((x) => <option key={x.code} value={x.code}>{x.title}</option>)}
          </select>
        </label>
        <label style={s.label}>Категория
          <select style={s.input} value={form.category} onChange={(e) => set({ category: e.target.value, object: "", position: "", block: "" })}>
            <option value="">— выберите —</option>
            {Object.keys(objectCategoryOptions).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label style={s.label}>Объект
          <select style={s.input} value={form.object} disabled={!form.category} onChange={(e) => set({ object: e.target.value, position: "", block: "" })}>
            <option value="">— выберите —</option>
            {objects.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        {positions.length > 0 && (
          <label style={s.label}>Позиция
            <select style={s.input} value={form.position} onChange={(e) => set({ position: e.target.value, block: "" })}>
              <option value="">— выберите —</option>
              {positions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        )}
        {blocks.length > 0 && (
          <label style={s.label}>Дом (блок)
            <select style={s.input} value={form.block} onChange={(e) => set({ block: e.target.value })}>
              <option value="">— выберите —</option>
              {blocks.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
        )}
        <label style={s.label}>PDF-файл (векторный, с текстовым слоем)
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" style={s.input} onChange={(e) => setFile(e.target.files[0] || null)} />
        </label>
      </div>
      <button type="submit" style={busy ? { ...s.primary, ...s.disabled } : s.primary} disabled={busy}>
        {busy ? "Загружаем…" : "Загрузить и разобрать"}
      </button>
      {file && <span style={{ ...s.muted, marginLeft: 12 }}>{file.name} · {(file.size / 1048576).toFixed(1)} МБ</span>}
      <div style={{ ...s.muted, marginTop: 8 }}>
        Разбор больших файлов занимает до минуты. Сканы (картинки без текста) не распознаются — для них будет сообщение.
      </div>
    </form>
  );
}

export default function DocumentsScreen({ onOpen }) {
  const [documents, setDocuments] = useState([]);
  const [sections, setSections] = useState([{ code: SECTION_DEFAULT, title: "КЖ — конструкции железобетонные" }]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { documents: list } = await ptoGet("/documents");
      setDocuments(list);
      setError("");
    } catch (err) {
      setError(err.message || "Не удалось загрузить список");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    ptoGet("/sections").then((r) => r.sections.length && setSections(r.sections)).catch(() => {});
  }, [load]);

  const parsing = documents.some((d) => d.status === "parsing");
  useEffect(() => {
    if (!parsing) return undefined;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [parsing, load]);

  const remove = async (d) => {
    if (!window.confirm(`Удалить документ «${d.fileName}» вместе с ведомостью и расценками?`)) return;
    try {
      await ptoDelete(`/documents/${d.id}`);
      load();
    } catch (err) {
      setError(err.message || "Не удалось удалить");
    }
  };

  return (
    <>
      <UploadForm sections={sections} onUploaded={() => load()} />
      {error && <div style={s.error}>{error}</div>}
      <div style={s.card}>
        <h3 style={s.cardTitle}>Документы</h3>
        {loading ? <div style={s.muted}>Загрузка…</div> : documents.length === 0 ? (
          <div style={s.muted}>Пока ничего не загружено.</div>
        ) : (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>№</th><th style={s.th}>Объект</th><th style={s.th}>Позиция</th><th style={s.th}>Блок</th><th style={s.th}>Раздел</th>
                  <th style={s.th}>Файл</th><th style={s.th}>Статус</th><th style={s.th}>Загружен</th><th style={s.th} />
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => {
                  const st = DOC_STATUS[d.status] || DOC_STATUS.draft;
                  return (
                    <tr key={d.id}>
                      <td style={s.td}>{d.id}</td>
                      <td style={s.td}>{d.object}</td>
                      <td style={s.td}>{d.position || "—"}</td>
                      <td style={s.td}>{d.block || "—"}</td>
                      <td style={s.td}>{d.section}</td>
                      <td style={s.td}>{d.fileName}{d.pageCount ? <span style={s.tag}>{d.pageCount} л.</span> : null}</td>
                      <td style={s.td}>
                        <span style={s.chip(st.color, st.bg)}>{st.label}</span>
                        {d.status === "error" && <div style={{ ...s.muted, color: "#c00", marginTop: 4, maxWidth: 360 }}>{d.error}</div>}
                      </td>
                      <td style={s.td}>{formatDate(d.uploadedAt)}</td>
                      <td style={s.td}>
                        <button style={d.status === "parsing" ? { ...s.smallPrimary, ...s.disabled } : s.smallPrimary} disabled={d.status === "parsing"} onClick={() => onOpen(d.id)}>Открыть</button>
                        <button style={s.smallDanger} onClick={() => remove(d)}>Удалить</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
