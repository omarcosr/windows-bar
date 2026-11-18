/**
 * Which form the widgets being rendered take. The dock on a side edge draws them minimal and the
 * hover peek (menu/widget-peek.tsx) draws the hovered one in full, from the same mounted widget.
 * Each window's view sets it at the start of its render: a window compiles its whole tree in one
 * synchronous pass, so every Tile in that pass reads its own window's form.
 */
let full = false;

export function setFullForm(on: boolean) {
  full = on;
}

export function fullForm() {
  return full;
}
