// Вкладка «Итого»: стоимость раздела (материалы + работы) с разбивкой по
// конструктивным элементам. Цены на материалы — ориентировочные, их можно
// изменить здесь же (пока утверждённого прайса нет).
import React, { useEffect, useState } from "react";
import { ptoGet, ptoPut } from "./api";
import { fmtMoney, fmtNum } from "./format";
import { s } from "./styles";

function MaterialPrices({ prices, onSaved, onError }) {
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => setValues(Object.fromEntries(prices.map((p) => [p.kind, String(p.price)]))), [prices]);
  const save = async (p) => {
    setBusy(true);
    try {
      await ptoPut(`/material-prices/${p.kind}`, { price: values[p.kind] });
      onSaved();
    } catch (err) {
      onError(err.message || "Не удалось сохранить цену");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ ...s.card, background: "#fafafa" }}>
      <b style={{ fontSize: 14 }}>Цены на материалы</b>
      <div style={{ ...s.muted, margin: "4px 0 8px" }}>Ориентировочные — утверждённого прайса пока нет. Изменение пересчитывает стоимость во всех документах.</div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {prices.map((p) => (
          <div key={p.kind} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13 }}>{p.name}, ₸ за {p.unit}:</span>
            <input style={{ ...s.inputSmall, width: 110 }} inputMode="decimal" value={values[p.kind] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.kind]: e.target.value }))} />
            <button style={s.small} disabled={busy || String(p.price) === values[p.kind]} onClick={() => save(p)}>Сохранить</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TotalsTab({ doc, version, onError }) {
  const [data, setData] = useState(null);
  const [prices, setPrices] = useState([]);

  const load = async () => {
    try {
      const [t, p] = await Promise.all([ptoGet(`/documents/${doc.id}/totals`), ptoGet("/material-prices")]);
      setData(t);
      setPrices(p.prices);
    } catch (err) {
      onError(err.message || "Не удалось посчитать итоги");
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [doc.id, version]);

  if (!data) return <div style={s.muted}>Считаем…</div>;
  const g = data.totals;
  return (
    <div>
      <MaterialPrices prices={prices} onSaved={load} onError={onError} />
      {g.missing > 0 && (
        <div style={s.warn}>В итог не вошло работ без расценки: {g.missing}. Подберите расценки на вкладке «Виды работ».</div>
      )}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Конструктивный элемент</th><th style={s.th}>Сталь, тн</th><th style={s.th}>Сталь, ₸</th>
              <th style={s.th}>Бетон, м³</th><th style={s.th}>Бетон, ₸</th><th style={s.th}>Материалы</th><th style={s.th}>Работы</th><th style={s.th}>Всего</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.element}>
                <td style={s.td}>{r.element}{r.missing > 0 && <span style={{ ...s.tag, background: "#fff1c9", color: "#8a5a00" }}>работ без расценки: {r.missing}</span>}</td>
                <td style={s.tdNum}>{fmtNum(r.steelT)}</td><td style={s.tdNum}>{fmtMoney(r.steelCost)}</td>
                <td style={s.tdNum}>{fmtNum(r.concreteM3)}</td><td style={s.tdNum}>{fmtMoney(r.concreteCost)}</td>
                <td style={s.tdNum}>{fmtMoney(r.materials)}</td><td style={s.tdNum}>{fmtMoney(r.works)}</td>
                <td style={{ ...s.tdNum, fontWeight: 700 }}>{fmtMoney(r.total)}</td>
              </tr>
            ))}
            <tr style={{ background: "#eef2f7", fontWeight: 700 }}>
              <td style={s.td}>ИТОГО по разделу</td>
              <td style={s.tdNum}>{fmtNum(g.steelT)}</td><td style={s.tdNum} />
              <td style={s.tdNum}>{fmtNum(g.concreteM3)}</td><td style={s.tdNum} />
              <td style={s.tdNum}>{fmtMoney(g.materials)}</td><td style={s.tdNum}>{fmtMoney(g.works)}</td><td style={s.tdNum}>{fmtMoney(g.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ ...s.muted, marginTop: 8 }}>
        Материалы: арматура и закладные — по цене за тонну, бетон (в т.ч. бетонная подготовка) — за м³. Работы: объём × расценка с НДС.
        В расчёт входят только строки с отметкой «в расчёте»; прочий металл (трубы, листы) и арматура по спецификациям при наличии сводной ведомости — справочно.
      </div>
    </div>
  );
}
