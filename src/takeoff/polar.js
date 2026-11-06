// Полярное отслеживание при обводке (удерживается Shift): направление от предыдущей точки округляется до
// угла, кратного шагу (45° — горизонталь, вертикаль и диагонали; 15° и 30° — ещё мельче). Точка остаётся
// на этом луче под курсором. Шаг 90° и больше — прежнее поведение: строго горизонтально или вертикально.
// Углы — как в CAD: от горизонтали против часовой стрелки (на листе ось Y направлена вниз, поэтому знак меняется).

export const POLAR_STEPS = [90, 45, 30, 15];

function snapOrtho(p, last) {
  if (!last) return p;
  return Math.abs(p.x - last.x) >= Math.abs(p.y - last.y) ? { x: p.x, y: last.y } : { x: last.x, y: p.y };
}

export function snapPolar(p, last, step = 90) {
  if (!last) return p;
  if (!(step > 0) || step >= 90) return snapOrtho(p, last);
  const dx = p.x - last.x;
  const dy = p.y - last.y;
  if (dx === 0 && dy === 0) return p;
  const unit = (step * Math.PI) / 180;
  const snapped = Math.round(Math.atan2(dy, dx) / unit) * unit;
  const d = dx * Math.cos(snapped) + dy * Math.sin(snapped); // проекция курсора на луч
  return { x: last.x + d * Math.cos(snapped), y: last.y + d * Math.sin(snapped) };
}

// Угол отрезка last → p в градусах, 0…360, против часовой от горизонтали
export function polarAngle(last, p) {
  const deg = (-Math.atan2(p.y - last.y, p.x - last.x) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}
