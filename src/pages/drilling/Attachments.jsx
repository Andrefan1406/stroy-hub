// Чертежи и фото к заявке на бурение: выбор файлов (PDF, картинки), на телефоне — кнопка
// «Сфотографировать»; список выбранных с поворотом снимков; галерея приложенных файлов с
// просмотром (картинку можно повернуть); добавление к готовой заявке. Фото сжимаются перед
// отправкой (см. prepareForUpload в drillingApi.js).
import React, { useCallback, useEffect, useRef, useState } from "react";
import css from "../../ConcreteRequestPage.module.css";
import styles from "./Drilling.module.css";
import { useConfirm } from "../../components/ConfirmDialog";
import { deleteAttachment, fetchAttachmentBlob, localFileProblem, uploadAttachment } from "./drillingApi";

const fmtSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1).replace(".", ",")} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);
const isTouch = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
const isImage = (mimeOrFile) => String(mimeOrFile?.type || mimeOrFile || "").startsWith("image/");
// Выбранный файл в форме: сам файл и поворот (в градусах по часовой), который применится при отправке.
export const toPending = (files) => files.map((file) => ({ file, rotate: 0 }));
const asItem = (x) => (x && x.file ? x : { file: x, rotate: 0 });

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

// Миниатюра выбранного (ещё не отправленного) файла; повёрнута так, как уйдёт на сервер.
function PendingThumb({ file, rotate }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!isImage(file)) return undefined;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src
    ? <img src={src} alt="" className={`${styles.thumbImg} ${styles.thumbRot}`} style={{ transform: `rotate(${rotate}deg)` }} />
    : <div className={styles.thumbIcon} aria-hidden="true">📄</div>;
}

// Список выбранных файлов формы: имя, размер, замечание (если файл не подойдёт), поворот снимка, «убрать».
export function PendingFiles({ items, onRotate, onRemove, disabled = false }) {
  if (!items.length) return null;
  return (
    <ul className={styles.fileList}>
      {items.map((raw, i) => {
        const { file, rotate } = asItem(raw);
        const problem = localFileProblem(file);
        return (
          <li key={`${file.name}-${file.size}-${i}`} className={styles.fileCard}>
            <PendingThumb file={file} rotate={rotate} />
            <div className={styles.fileMeta}>
              <div className={styles.fileName} title={file.name}>{file.name}</div>
              <div className={styles.fileSub}>{fmtSize(file.size)}</div>
              {problem && <div className={css.fieldError}>{problem}</div>}
              {isImage(file) && (
                <div className={styles.rotateBar}>
                  <button type="button" className={styles.rotateBtn} disabled={disabled} onClick={() => onRotate(i, -90)} title="Повернуть влево" aria-label={`Повернуть влево ${file.name}`}>⟲</button>
                  <button type="button" className={styles.rotateBtn} disabled={disabled} onClick={() => onRotate(i, 90)} title="Повернуть вправо" aria-label={`Повернуть вправо ${file.name}`}>⟳</button>
                </div>
              )}
            </div>
            <button type="button" className={styles.fileRemove} disabled={disabled} onClick={() => onRemove(i)} aria-label={`Убрать ${file.name}`}>×</button>
          </li>
        );
      })}
    </ul>
  );
}

// Загружает файлы по очереди (с учётом поворота); возвращает [{ name, error }] по тем, что не удалось.
export async function uploadMany(requestId, items, onProgress) {
  const failed = [];
  for (let i = 0; i < items.length; i += 1) {
    const { file, rotate } = asItem(items[i]);
    onProgress?.(i + 1, items.length);
    try {
      await uploadAttachment(requestId, file, rotate);
    } catch (err) {
      failed.push({ name: file.name, error: err.message });
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

// Просмотр картинки на весь экран: поворот влево/вправо (только для просмотра — файл не меняется), закрытие по Esc.
function ImageViewer({ url, name, onClose }) {
  const [rotate, setRotate] = useState(0);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setRotate((r) => r - 90);
      if (e.key === "ArrowRight") setRotate((r) => r + 90);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const sideways = Math.abs(rotate / 90) % 2 === 1;
  return (
    <div className={styles.viewer} role="dialog" aria-modal="true" aria-label={name}>
      <div className={styles.viewerBar}>
        <div className={styles.viewerName} title={name}>{name}</div>
        <button type="button" className={styles.viewerBtn} onClick={() => setRotate((r) => r - 90)} aria-label="Повернуть влево">⟲ Влево</button>
        <button type="button" className={styles.viewerBtn} onClick={() => setRotate((r) => r + 90)} aria-label="Повернуть вправо">⟳ Вправо</button>
        <button type="button" className={styles.viewerBtn} onClick={onClose}>Закрыть</button>
      </div>
      <div className={styles.viewerStage} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <img
          src={url}
          alt={name}
          className={styles.viewerImg}
          style={{ transform: `rotate(${rotate}deg)`, maxWidth: sideways ? "82vh" : "96vw", maxHeight: sideways ? "96vw" : "82vh" }}
        />
      </div>
    </div>
  );
}

// PDF открываем в новой вкладке: вкладку открываем сразу (по нажатию), а адрес подставляем, когда файл
// загружен, иначе браузер на телефоне блокирует «всплывающее окно».
async function openPdfInTab(requestId, att, onError) {
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
  const [viewer, setViewer] = useState(null); // { url, name } — открытая на весь экран картинка
  const closeViewer = useCallback(() => {
    setViewer((v) => { if (v) URL.revokeObjectURL(v.url); return null; });
  }, []);
  if (!attachments.length) return confirmDialog;

  const open = async (att) => {
    if (!isImage(att.mime)) return openPdfInTab(requestId, att, onError);
    try {
      const blob = await fetchAttachmentBlob(requestId, att.id);
      setViewer({ url: URL.createObjectURL(blob), name: att.name });
    } catch (err) {
      onError?.(err.message);
    }
    return undefined;
  };

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
            <button type="button" className={styles.thumbBtn} onClick={() => open(a)} aria-label={`Открыть ${a.name}`}>
              <Thumb requestId={requestId} att={a} />
            </button>
            <div className={styles.fileMeta}>
              <div className={styles.fileName} title={a.name}>{a.name}</div>
              <div className={styles.fileSub}>{fmtSize(a.size)}</div>
              <button type="button" className={styles.linkBtn} onClick={() => open(a)}>{isImage(a.mime) ? "Открыть, повернуть" : "Открыть"}</button>
            </div>
            {canEdit && <button type="button" className={styles.fileRemove} onClick={() => remove(a)} aria-label={`Удалить ${a.name}`}>×</button>}
          </li>
        ))}
      </ul>
      {confirmDialog}
      {viewer && <ImageViewer url={viewer.url} name={viewer.name} onClose={closeViewer} />}
    </>
  );
}

// Добавление файлов к уже поданной заявке (пока её не приняли): выбрал, при необходимости повернул, нажал «Загрузить».
export function AttachmentAdder({ requestId, remaining, onDone, onError }) {
  const [items, setItems] = useState([]);
  const [progress, setProgress] = useState(null); // { i, n }

  const pick = (files) => {
    if (items.length + files.length > remaining) {
      onError?.(`Можно добавить ещё не больше ${remaining} файл(ов)`);
      return;
    }
    setItems((cur) => [...cur, ...toPending(files)]);
  };

  const send = async () => {
    const problem = items.map((it) => localFileProblem(it.file)).find(Boolean);
    if (problem) { onError?.(problem); return; }
    const failed = await uploadMany(requestId, items, (i, n) => setProgress({ i, n }));
    setProgress(null);
    setItems(failed.length ? items.filter((it) => failed.some((f) => f.name === it.file.name)) : []);
    if (failed.length) onError?.(`Не загружено: ${failed.map((f) => `${f.name} — ${f.error}`).join("; ")}`);
    onDone?.();
  };

  return (
    <div>
      <AttachmentPicker onFiles={pick} disabled={!!progress || remaining <= 0} />
      <PendingFiles
        items={items}
        disabled={!!progress}
        onRotate={(i, d) => setItems((cur) => cur.map((it, k) => (k === i ? { ...it, rotate: it.rotate + d } : it)))}
        onRemove={(i) => setItems((cur) => cur.filter((_, k) => k !== i))}
      />
      {items.length > 0 && (
        <button type="button" className={css.btnPrimary} style={{ marginTop: 10 }} disabled={!!progress} onClick={send}>
          {progress ? `Загружаю файл ${progress.i} из ${progress.n}…` : `Загрузить (${items.length})`}
        </button>
      )}
      {remaining <= 0 && <div className={styles.hint}>Достигнут предел числа файлов.</div>}
    </div>
  );
}
