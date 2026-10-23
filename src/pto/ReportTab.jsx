// Вкладка «Отчёт разбора»: какие листы распознаны, что не удалось разобрать,
// сверка со сводной ведомостью. Ошибки парсинга не роняют разбор — они здесь.
import React from "react";
import { fmtNum } from "./format";
import { s } from "./styles";

export default function ReportTab({ doc }) {
  const report = doc.report;
  if (!report) return <div style={s.muted}>Отчёта нет.</div>;
  const warnings = report.issues.filter((i) => i.level !== "info");
  const notes = report.issues.filter((i) => i.level === "info");
  const kindTitle = { steel_summary: "сводная ведомость стали", specification: "спецификация" };
  return (
    <div>
      <div style={s.muted}>Листов в файле: {report.pageCount}. Распознано таблиц: {report.sheets.length}. Строк разобрано: {report.stats.rawRows}, позиций в ведомости: {report.stats.items}.</div>

      <h4 style={{ margin: "16px 0 8px" }}>Что проверить ({warnings.length})</h4>
      {warnings.length === 0 ? <div style={s.notice}>Все найденные таблицы разобраны без замечаний.</div> : warnings.map((i, k) => (
        <div key={k} style={s.warn}>{i.page ? <b>Лист {i.page}: </b> : null}{i.message}</div>
      ))}

      {report.reconciliation && report.reconciliation.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 8px" }}>Сверка со сводной «Ведомостью расхода стали»</h4>
          <table style={{ ...s.table, maxWidth: 640 }}>
            <thead><tr><th style={s.th}>Группа</th><th style={s.th}>По спецификациям, кг</th><th style={s.th}>По ведомости, кг</th><th style={s.th}>Отношение</th><th style={s.th}>Коэффициент</th></tr></thead>
            <tbody>
              {report.reconciliation.map((r) => (
                <tr key={r.id}>
                  <td style={s.td}>{r.title}</td><td style={s.tdNum}>{fmtNum(r.specKg)}</td><td style={s.tdNum}>{fmtNum(r.summaryKg)}</td>
                  <td style={s.tdNum}>{fmtNum(r.ratio)}</td>
                  <td style={s.td}>{r.applied ? `применён ×${r.applied}` : r.status === "ok" ? "не нужен" : r.factor ? `предложен ×${r.factor}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4 style={{ margin: "16px 0 8px" }}>Распознанные листы</h4>
      <div style={s.tableWrap}>
        <table style={{ ...s.table, maxWidth: 900 }}>
          <thead><tr><th style={s.th}>Лист</th><th style={s.th}>Что</th><th style={s.th}>Название</th><th style={s.th}>Строк</th></tr></thead>
          <tbody>
            {report.sheets.map((sh, k) => (
              <tr key={k}><td style={s.td}>{sh.page}</td><td style={s.td}>{kindTitle[sh.kind] || sh.kind}</td><td style={s.td}>{sh.title}</td><td style={s.tdNum}>{sh.rows}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {notes.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer" }}>Заметки ({notes.length}) — таблицы без материалов (перечни элементов, схемы)</summary>
          <div style={{ marginTop: 8 }}>{notes.map((i, k) => <div key={k} style={{ ...s.muted, padding: "2px 0" }}>Лист {i.page}: {i.message}</div>)}</div>
        </details>
      )}
    </div>
  );
}
