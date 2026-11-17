import { Row, Text, View, toRaw, type Child } from "@tarve/core";
import { ui } from "../../../theme";

/** Each instance's "refresh now", keyed by its raw state (menu() only receives the state). */
export const refreshers = new WeakMap<object, () => Promise<void>>();

export function registerRefresh(state: object, load: () => Promise<void>) {
  refreshers.set(toRaw(state), load);
}

export function refreshNow(state: object) {
  void refreshers.get(toRaw(state))?.();
}

/** Compact pt-BR number: 1,2 mil, 3,4 mi. */
export function compact(n: number) {
  return new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function errorText(error: unknown) {
  const s = String(error instanceof Error ? error.message : error);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

/** Brand mark: a coloured rounded square with a letter. */
export function Badge(props: { color: string; letter: string; size?: number; fg?: string }) {
  const s = props.size ?? 16;
  return (
    <View style={{ width: s, height: s, radius: s * 0.3, background: props.color, align: "center", justify: "center", shrink: 0 }}>
      <Text size={Math.round(s * 0.6)} weight={800} color={props.fg ?? "#fff"}>
        {props.letter}
      </Text>
    </View>
  );
}

/** Title line with the "demo" / "erro" tag. */
export function Title(props: { text: string; demo: boolean; error?: string }) {
  return (
    <Text size={11} weight={600} color={ui.text} style={{ flex: 1 }}>
      {props.text}
      {props.error ? (
        <Text size={9} color={ui.danger}>
          {" "}
          erro
        </Text>
      ) : props.demo ? (
        <Text size={9} color={ui.faint}>
          {" "}
          demo
        </Text>
      ) : null}
    </Text>
  );
}

/** Small label + value column. */
export function Stat(props: { label: string; value: Child; color?: string }) {
  return (
    <Row style={{ align: "center", gap: 3 }}>
      <Text size={12} weight={700} color={props.color ?? ui.text}>
        {props.value}
      </Text>
      <Text size={9} color={ui.muted}>
        {props.label}
      </Text>
    </Row>
  );
}

/** Week-over-week arrow and percentage. */
export function Trend(props: { change: number }) {
  const up = props.change >= 0;
  return (
    <Text size={10} weight={700} color={up ? ui.green : ui.danger}>
      {`${up ? "▲" : "▼"} ${Math.abs(Math.round(props.change))}%`}
    </Text>
  );
}

export function percentChange(current: number, previous: number) {
  return previous ? ((current - previous) / Math.abs(previous)) * 100 : 0;
}
