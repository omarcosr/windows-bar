# Runtime e renderer: por que Bun + GPU

**Decisão:** a versão distribuída do WindowsBar usa o runtime **Bun** (build com `--trim`) e o renderer **`auto`** do Tarve, que no Windows é a GPU (D3D11). Antes era txiki com `renderer: "cpu"` e `lowPower: true`.

| Onde | Configuração |
| --- | --- |
| `src/main.tsx` | `createApp(..., { renderer: "auto" })`, sem `lowPower` (as janelas abertas com `app.openWindow` herdam) |
| `package.json` | `build` → `build:bun`, com `--trim` |
| `scripts/release.ts` | `--runtime` padrão `bun` (já aplicava `--trim` ao Bun) |
| `.github/workflows/release.yml` | tags e execução manual usam `bun` por padrão |

## Por quê

O dock era menos fluido que outros docks nativos (como o PearUI, em WPF). As medições apontaram duas causas independentes:

- **Renderer de CPU:** cada quadro animado é rasterizado na CPU. O próprio Tarve descreve o `lowPower` como "~90 MB less, more CPU per frame while animating or scrolling".
- **txiki (QuickJS, sem JIT):** cada evento redesenha o dock inteiro no JS, cerca de 7 a 9 ms por atualização no txiki, contra cerca de 2 ms no Bun. Isso gera travadas de vários quadros durante o hover.

## Medições

Tarve 0.13.7, Bun 1.4.6, Core Ultra 7 255HX, tela de 60 Hz na GPU Intel. Para cada combinação: 30 s com o ponteiro varrendo a barra (900 px/s) e 30 s parado, com `WINDOWSBAR_PERF=1` (`src/runtime/perf-probe.ts`) e o CPU do processo lido pelo sistema. Fiz uma rodada por combinação. "highlight" é o efeito de hover padrão; "macos" amplia os ícones e é o mais pesado.

| Versão | Executável | CPU varrendo (highlight / macos) | Atualização do JS p95 (macos) | Espera do mouse p95 (macos) | Pior atraso do loop (macos) | Memória em uso / privada |
| --- | --- | --- | --- | --- | --- | --- |
| txiki + CPU (anterior) | 15 MB | 31% / 42% | 9,0 ms | 7,8 ms | 61 ms | ~100 / ~100 MB |
| txiki + GPU | 15 MB | 6% / 16% | 8,3 ms | 6,8 ms | 53 ms | ~300 / ~295 MB |
| Bun + CPU | 166 MB | 33% / 34% | 1,8 ms | 1,5 ms | 3 ms | ~150 / ~270 MB |
| Bun + GPU | 166 MB | 6% / 11% | 2,1 ms | 1,4 ms | 4 ms | ~345 / ~805 MB |
| **Bun + GPU, `--trim` (atual)** | **100 MB** | 7% / 10% | 2,1 ms | 1,4 ms | 4 ms | ~345 / ~800 MB |
| Bun + GPU, `--trim --aot` | 87 MB | 5% / 8% | 2,1 ms | 1,6 ms | 4 ms | ~315 / ~1120 MB |

Porcentagens de CPU em relação a um núcleo. Parado, todas as versões ficaram abaixo de ~1%, com algumas leituras ruidosas de 3 a 5%.

- A GPU reduz o CPU das animações em 4 a 5 vezes nos dois runtimes.
- O Bun deixa o JS cerca de 4 vezes mais rápido e elimina as travadas: 53 a 61 ms equivalem a 3 ou 4 quadros perdidos a 60 Hz.
- `--trim` remove 66 MB do executável sem efeito mensurável.
- `--aot` ficou de fora: o ganho de CPU foi pequeno e não conclusivo em uma rodada, a memória privada sobe cerca de 320 MB, a opção é experimental, e o `tarve build --aot` só funciona com `TARVE_BYTECODE=0` (`compile.aot cannot be used with bytecode`).
- A versão Node não inicia com o Tarve 0.13.7 (`Could not create native event wake pipe: 231`) e ficou fora da comparação.

## Custos aceitos

- **Executável:** de 15 MB para ~100 MB. Cópias instaladas de versões txiki baixam o executável inteiro na primeira atualização; as seguintes voltam a usar os packs incrementais.
- **Memória:** de ~100 MB para ~345 MB em uso e ~800 MB de memória privada (reservada), principalmente pelo driver da GPU e pelo heap do Bun.

## Problema conhecido, independente desta escolha

Em todas as combinações, o loop do JS trava por 1,4 a 2,9 s logo depois de abrir, em `refreshWindows`. Isso ainda precisa ser investigado.

## Repetir as medições

1. Gere as versões (`bun run build:bun`, `bun run build:txiki`) com o renderer a comparar em `src/main.tsx`. A opção do `createApp` prevalece sobre `TARVE_RENDERER`.
2. Feche o WindowsBar instalado (`WindowsBar.exe --quit`): só roda um por vez.
3. Rode cada exe com `WINDOWSBAR_PERF=1` e um `APPDATA` próprio (para não tocar na sua configuração), com o stdout redirecionado para um arquivo. Mova o ponteiro sobre a barra no segundo bloco de 30 s. O relatório desse bloco traz `stats dock` com `js.update`, `native.phases.eventWait` e a memória; o CPU do processo vem de `GetProcessTimes`, porque o txiki não implementa `process.cpuUsage`.
4. Para ver o custo de cada quadro na tela, use `TARVE_FRAME_OVERLAY=1`.
