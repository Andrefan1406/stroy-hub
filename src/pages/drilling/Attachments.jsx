// Чертежи и фото к заявке на бурение: выбор файлов (PDF, картинки), на телефоне — кнопка
// «Сфотографировать»; список выбранных; галерея уже приложенных файлов; добавление к готовой
// заявке. Фото сжимаются перед отправкой (см. prepareForUpload в drillingApi.js).
import React, { useCallback, useEffect, useRef, useState } from "react";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";
import { useConfirm } from "../../components/ConfirmDialog";
import { deleteAttachment, fetchAttachmentBlob, localFileProblem, uploadAttachment } from "./drillingApi";

const fmtSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1).replace(".", ",")} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);
const isTouch = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
const isImage = (mimeOrFile) => String(mimeOrFile?.type || mimeOrFile || "").startsWith("image/");

// Кнопки выбора. onFiles(File[]) — выбранные файлы (камера отдаёт один снимок).
export function AttachmentPicker({ onFiles, disabled = false }) {
  const filesRef = useRef(null);
  const cameraRef = useRef(null);
  const take = (e) => {
    const list = [...(e.target.files || [])];
    e.target.value = ""; // тот же файл можно выбрать повторно
    if (list.length) onFiles(list);
  };
  return (
    <div className={styles.pickerRow}>
      <input ref={filesRef} type="file" multiple accept="application/pdf,image/*" hidden onChange={take} />
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={take} />
      <button type="button" className={css.btnGhost} style={{ marginRight: 0 }} disabled={disabled} onClick={() => filesRef.current?.click()}>
        📎 Выбрать PDF или фото
      </button>
      {isTouch() && (
        <button type="button" className={css.btnGhost} style={{ marginRight: 0 }} disabled={disabled} onClick={() => cameraRef.current?.click()}>
          📷 Сфотографировать
        </button>
      )}
    </div>
  );
}

// Миниатюра выбранного (ещё не отправленного) файла.
function PendingThumb({ file }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!isImage(file)) return undefined;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src ? <img src={src} alt="" className={styles.thumbImg} /> : <div className={styles.thumbIcon} aria-hidden="true">📄</div>;
}

// Список выбранных файлов формы: имя, размер, замечание (если файл не подойдёт), кнопка «убрать».
export function PendingFiles({ files, onRemove, disabled = false }) {
  if (!files.length) return null;
  return (
    <ul className={styles.fileList}>
      {files.map((f, i) => {
        const problem = localFileProblem(f);
        return (
          <li key={`${f.name}-${f.size}-${i}`} className={styles.fileCard}>
            <PendingThumb file={f} />
            <div className={styles.fileMeta}>
              <div className={styles.fileName} title={f.name}>{f.name}</div>
              <div className={styles.fileSub}>{fmtSize(f.size)}</div>
              {problem && <div className={css.fieldError}>{problem}</div>}
            </div>
            <button type="button" className={styles.fileRemove} disabled={disabled} onClick={() => onRemove(i)} aria-label={`Убрать ${f.name}`}>×</button>
          </li>
        );
      })}
    </ul>
  );
}

// Загружает файлы по очереди; возвращает [{ name, error }] по тем, что не удалось.
export async function uploadMany(requestId, files, onProgress) {
  const failed = [];
  for (let i = 0; i < files.length; i += 1) {
    onProgress?.(i + 1, files.length);
    try {
      await uploadAttachment(requestId, files[i]);
    } catch (err) {
      failed.push({ name: files[i].name, error: err.message });
    }
  }
  return failed;
}

// Миниатюра приложенного файла: картинки подгружаются с токеном и показываются превью.
function Thumb({ requestId, att }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!isImage(att.mime)) return undefined;
    let url = "";
    let alive = true;
    fetchAttachmentBlob(requestId, att.id).then((blob) => { if (alive) { url = URL.createObjectURL(blob); setSrc(url); } }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [requestId, att.id, att.mime]);
  return src ? <img src={src} alt={att.name} className={styles.thumbImg} /> : <div className={styles.thumbIcon} aria-hidden="true">{isImage(att.mime) ? "🖼" : "📄"}</div>;
}

// Открывает файл в новой вкладке. Вкладку открываем сразу (по нажатию), а адрес подставляем, когда
// файл загружен: иначе браузер на телефоне блокирует «всплывающее окно».
async function openInTab(requestId, att, onError) {
  const tab = window.open("", "_blank");
  try {
    const blob = await fetchAttachmentBlob(requestId, att.id);
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url; else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  } catch (err) {
    if (tab) tab.close();
    onError?.(err.message);
  }
}

// Галерея приложенных файлов. canEdit — автор может удалять (onChanged получает обновлённую заявку).
export function AttachmentGallery({ requestId, attachments, canEdit = false, onChanged, onError }) {
  const [confirm, confirmDialog] = useConfirm();
  if (!attachments.length) return null;

  const remove = async (att) => {
    if (!(await confirm({ title: "Удалить файл?", text: att.name, confirmLabel: "Удалить", danger: true }))) return;
    try {
      onChanged?.(await deleteAttachment(requestId, att.id));
    } catch (err) {
      onError?.(err.message);
    }
  };

  return (
    <>
      <ul className={styles.fileList}>
        {attachments.map((a) => (
          <li key={a.id} className={styles.fileCard}>
            <button type="button" className={styles.thumbBtn} onClick={() => openInTab(requestId, a, onError)} aria-label={`Открыть ${a.name}`}>
              <Thumb requestId={requestId} att={a} />
            </button>
            <div className={styles.fileMeta}>
              <div className={styles.fileName} title={a.name}>{a.name}</div>
              <div className={styles.fileSub}>{fmtSize(a.size)}</div>
              <button type="button" className={styles.linkBtn} onClick={() => openInTab(requestId, a, onError)}>Открыть</button>
            </div>
            {canEdit && <button type="button" className={styles.fileRemove} onClick={() => remove(a)} aria-label={`Удалить ${a.name}`}>×</button>}
          </li>
        ))}
      </ul>
      {confirmDialog}
    </>
  );
}

// Добавление файлов к уже поданной заявке (пока её не приняли): выбрал — сразу ушло.
export function AttachmentAdder({ requestId, remaining, onDone, onError }) {
  const [progress, setProgress] = useState(null); // { i, n }
  const add = useCallback(async (files) => {
    if (files.length > remaining) {
      onError?.(`Можно добавить ещё не больше ${remaining} файл(ов)`);
      return;
    }
    const problems = files.map((f) => localFileProblem(f)).filter(Boolean);
    if (problems.length) { onError?.(problems[0]); return; }
    const failed = await uploadMany(requestId, files, (i, n) => setProgress({ i, n }));
    setProgress(null);
    if (failed.length) onError?.(`Не загружено: ${failed.map((f) => `${f.name} — ${f.error}`).join("; ")}`);
    onDone?.();
  }, [requestId, remaining, onDone, onError]);

  return (
    <div>
      <AttachmentPicker onFiles={add} disabled={!!progress || remaining <= 0} />
      {progress && <div className={styles.hint}>Загружаю файл {progress.i} из {progress.n}…</div>}
      {remaining <= 0 && <div className={styles.hint}>Достигнут предел числа файлов.</div>}
    </div>
  );
}
