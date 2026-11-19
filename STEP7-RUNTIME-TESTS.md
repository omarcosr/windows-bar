# STEP 7 — smoke tests dos runtimes

> Os ensaios 0.13.0 abaixo são históricos. A seção Tarve 0.13.2 ao final substitui as conclusões sobre ponteiros crus, `app.close()`, eventos de saída e watchdog. Falhas históricas não representam o suporte atual; GUI continua sem homologação.

Ambiente: Windows x64, Bun 1.4.4-canary.1, Node 26.10.0, Tarve 0.13.0. Executáveis recompilados após as correções abaixo. Testes sequenciais, sem encerrar aplicações de outras sessões.

## Como reproduzir

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-runtimes.ps1 -Mode floating -OutputDirectory "$env:TEMP\WindowsBar-floating"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-runtimes.ps1 -Mode full -OutputDirectory "$env:TEMP\WindowsBar-full"
bun test scripts/runtime-portability.test.ts
bun run typecheck
```

O script inicia os três exes e `bun run dev`, aguarda 8 segundos, consulta HWND/PID do dock, visibilidade da janela do Explorer e área útil via Win32. Testa o valor real de HKCU Run antes/depois de `--autostart on/off`, encaminha `--update` e `--quit`, registra stdout/stderr e encerra sua própria árvore de processos quando necessário. Recusa execução se já existir dock. Usa configuração isolada em APPDATA, com reserva de espaço e ocultação da barra ativadas, sem alterar config.json do usuário. Restaura o valor anterior de autostart no finally.

`--update` usa propositalmente um feed local indisponível: não baixa, instala, troca nem reinicia executáveis. A saída 0 do cliente só comprova o encaminhamento sem crash; não comprova atualização completa. No dev, os comandos são enviados pelo exe Bun ao mesmo ID de instância, não por `bun run dev --quit` (o CLI Tarve interpreta essa flag como própria).

## Checklist

OK significa apenas a evidência descrita na linha. Não equivale a homologação visual. “requer teste manual humano” não foi aprovado automaticamente.

| Item | txiki exe | Bun exe | Node exe | bun run dev |
|---|---|---|---|---|
| Processo de pé por 8 s, sem erro no stderr | OK | OK | OK | OK |
| Dock: HWND/PID existe, flutuante e completo | OK | OK | OK | OK |
| Dock: aparência e interação visíveis | requer teste manual humano | requer teste manual humano | requer teste manual humano | requer teste manual humano |
| AppBar: área útil reservada nos dois modos | OK | OK | OK | OK |
| Esconder barra nativa do Explorer | OK | OK | OK | OK |
| Bandeja: cliques esquerdo/direito/duplo | requer teste manual humano | requer teste manual humano | requer teste manual humano | requer teste manual humano |
| Badges: SQLite e overlays | requer teste manual humano | requer teste manual humano | requer teste manual humano | requer teste manual humano |
| Prévia: thumbnails e seleção | requer teste manual humano | requer teste manual humano | requer teste manual humano | requer teste manual humano |
| Prévia: Aero Peek por ponteiro cru | FALHA | requer teste manual humano | FALHA | requer teste manual humano |
| Menu iniciar e launch | requer teste manual humano | requer teste manual humano | requer teste manual humano | requer teste manual humano |
| Volume por COM | FALHA | requer teste manual humano | FALHA | requer teste manual humano |
| Rede e idioma | requer teste manual humano | requer teste manual humano | requer teste manual humano | requer teste manual humano |
| Cor do aplicativo | requer teste manual humano | requer teste manual humano | requer teste manual humano | requer teste manual humano |
| --autostart on/off: registro e saída 0 | OK | OK | OK | requer teste manual humano |
| --quit encerra o dock sem força | OK | OK | OK | OK |
| Restauração após --quit: barra e área útil | OK | OK | OK | OK |
| Restauração automática após limpeza forçada do teste | OK | FALHA no novo ensaio de kill | FALHA no novo ensaio de kill | FALHA no novo ensaio de kill |
| --update: cliente encaminha e dock continua de pé | OK | OK | OK | OK |
| --update: feed assinado, instalação e reinício | requer teste manual humano | requer teste manual humano | requer teste manual humano | requer teste manual humano |

Observações:
- `FindWindowW` encontra o dock em todos os runtimes, mas `IsWindowVisible` retorna false nesta sessão. A existência foi comprovada; a apresentação não. Não declarar a UI homologada.
- O ensaio original txiki falhava em `--quit`; o probe confirmou que o callback recebia a flag, mas `app.closed` não resolvia após `app.close()`. A correção encerra explicitamente pelo `exitApp` no txiki, após dar tempo à resposta single-instance, e registra a limpeza nativa com `onExit`. Bun/Node continuam usando `app.close()`.
- O probe txiki encontrou `process.pid=null` (ausente) e PID Win32 real=68764. Isso impedia distinguir a própria Shell_TrayWnd e lançava o watchdog sem PID válido. A fachada completa apenas o PID ausente via GetCurrentProcessId. A revalidação consulta a janela real de Explorer, que ficou oculta nos dois modos.
- Área útil revalidada no txiki: antes/depois = 0,0,2048,1232; durante flutuante = 0,0,2048,1200; durante completo = 0,0,2048,1216. Após `--quit` e após kill da árvore do teste, Explorer visível e state=0, sem fallback emergencial nas amostras aprovadas.
- A restauração emergencial usa scripts/restore-taskbar.ps1 quando necessário. Os primeiros ensaios precisaram dela após encerrar o supervisor de dev; as execuções finais usam --quit por single-instance e preservam o estado nativo no fallback.
- O stderr do dev contém a linha normal `$ bunx tarve dev src/main.tsx`; isso não é erro da aplicação.
- O novo ensaio deliberado de kill (`-TestForcedExit`) detectou que Bun/Node/dev podem permanecer em state=1 e área útil de 1280 mesmo com Explorer visível. Isso não é aprovação da restauração. Essas falhas adicionais foram registradas, sem alterar seus backends ou expandir o escopo solicitado (txiki). O fallback do teste agora também recupera divergências de estado/área útil, não apenas barra invisível.

## Correções mínimas encontradas pelos testes

1. Handles Win32 com extensão de sinal, como HDC `0xffffffffe1014366`, ultrapassavam Number.MAX_SAFE_INTEGER quando interpretados como unsigned. A fachada preserva o valor signed exato; o backend Node reconverte para unsigned de 64 bits ao passá-lo ao FFI (Node rejeita ponteiro negativo). Probe nativo reproduziu o handle; testes incluem 100 chamadas GetDC/ReleaseDC em Bun e em Node.
2. O Buffer shim txiki do Tarve não implementa UTF-16LE. Probe direto: encode('AB') produzia [65,66], decode([65,0,66,0]) produzia `A\0B\0`. Isso corrompia nomes, caminhos, classes Win32, idiomas e bandeja. encodeWide/decodeWide explícitos substituem todos os usos UTF-16LE de Buffer em src.
3. Aero Peek tentava CFunction mesmo nos backends sem suporte a ponteiro cru, gerando FfiUnsupported não capturado. Agora degrada para ausência de Peek, sem interromper a aplicação. Thumbnails DWM são outra API e continuam pendentes de teste humano.
4. Revalidação operacional: PID Win32 preenche a lacuna do shim txiki; `--quit` usa saída explícita apenas nesse runtime; `DockWindow` registra a restauração em `onExit`. O smoke passou a conferir visibilidade, estado de auto-hide e área útil antes de qualquer recuperação emergencial, inclusive após kill.

Typecheck, três builds e três testes de regressão (208 assertions) aprovados. Auditoria final: nenhum WindowsBar, dev ou watchdog iniciado pelo teste ficou de pé; HKCU Run retornou à ausência original. Não foram alteradas dependências Tarve, protocolo single-instance ou comportamento nativo além das correções acima.

## Limitações históricas do Node (Tarve 0.13.0)

- Requer Node >=26.10 e FFI experimental (`--experimental-ffi` na execução direta; o exe compilado já inicializa esse recurso).
- Backend não chama ponteiros crus: volume Core Audio por vtable COM, IImageList para ícones de shell e Aero Peek por ordinal ficam indisponíveis. Há fallback de ícones e valores ausentes; isso não significa equivalência funcional com Bun.
- Callbacks nativos da bandeja e worker de shell-events passaram o smoke de inicialização/encerramento; cliques, atualizações de janelas, fullscreen e multimonitor ainda requerem teste humano.
- Atualização real e atualização entre runtimes não foram exercitadas.

## Evidências

Resultados finais e logs por processo:
- `.empryo/tmp/tabs/t_mwjjn49f_1s73693c3d6a_8/step7-verified-floating/`
- `.empryo/tmp/tabs/t_mwjjn49f_1s73693c3d6a_8/step7-verified-full/`

Ensaios de reprodução e intermediários: `step7/`, `step7-after/`, `step7-final/`, `step7-full/` sob o mesmo diretório temporário.

## Revalidação das reprovações do txiki

Comandos finais, executados sequencialmente com os exes recompilados:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-runtimes.ps1 -OutputDirectory .empryo/tmp/txiki-fix-final2-floating -Mode floating -Runtimes txiki -TestForcedExit
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-runtimes.ps1 -OutputDirectory .empryo/tmp/txiki-fix-final2-full -Mode full -Runtimes txiki -TestForcedExit
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-runtimes.ps1 -OutputDirectory .empryo/tmp/txiki-fix-regression -Mode floating
```

Os três comandos saíram com código 0. Nos dois modos txiki: Explorer oculto; `--quit` encerrou o processo original com saída 0 sem taskkill; barra, state=0 e área útil 0,0,2048,1232 restaurados após `--quit` e após kill deliberado. A reserva durante execução foi 1200 (flutuante) e 1216 (completo). Nenhum fallback emergencial foi necessário nessas amostras. A regressão normal de Bun, Node e dev também passou (não equivale a aprovação do novo teste de kill nesses runtimes).

O observador preserva o snapshot bruto aos 8 s e permite até 1 s para o watcher de 250 ms ocultar uma reaparição do Explorer. Visibilidade persistente continua reprovando; nos dois ensaios finais `HideWaitMs=0`, sem usar essa tolerância. Um ensaio intermediário registrou reaparição no snapshot bruto; não foi apagado nem contado como aprovado.

Evidências por amostra: `results.json` e logs nos três diretórios dos comandos. Reprodução anterior: `.empryo/tmp/txiki-fix-before/results.json` (`ExitedAfterQuit=false`, `TaskbarRestored=false`). Typecheck, builds txiki/Bun/Node e os 3 testes de portabilidade (208 assertions) passaram. As alterações finais de código ficam somente em `src/native/ffi.ts`, `src/native/dock-window.ts` e `src/main.tsx`; as edições preexistentes das outras abas foram preservadas. Auditoria final: DockPid=0, Explorer visível, área útil 0,0,2048,1232, state=0, HKCU Run ausente como no início e nenhum watchdog dessas amostras ativo.

## Tarve 0.13.2

### Suporte nativo e escopo

`@tarve/core` está fixado em 0.13.2. O `pointerFunction` documentado pelo Tarve atende Bun, Node e txiki; `src/native/ffi.ts` agora o utiliza em `CFunction`. Logo, a ausência histórica de ponteiros crus não torna mais volume Core Audio/COM, IImageList ou Aero Peek indisponíveis no txiki/Node. Essa disponibilidade não constitui aprovação visual nem teste funcional isolado desses três recursos: os smokes abaixo não medem leitura de volume, pixels dos ícones ou efeito Peek.

Gaps restantes, com adaptações locais: **gap do Tarve — AppBar** (roteamento para nossa `Shell_TrayWnd` e posicionamento independente de `stripOverlap`); **gap do Tarve — shim txiki** (PID e UTF-16LE de `Buffer`); **gap do Tarve — APIs DWM específicas** (thumbnails, Peek e exclusão do preview continuam em FFI). Node mantém o requisito de FFI experimental. `tarve dev` não suporta txiki; o desenvolvimento usa Bun ou Node.

> **Atualização (Tarve 0.13.4):** os gaps de AppBar e de PID foram fechados pelo Tarve 0.13.3: a reserva usa `app.appBar(edge, { size, overlap })` e o app usa `process.pid`. No txiki, `run()` de `src/runtime/proc.ts` passou a usar o `spawn` detached do Tarve (probe: `shutdown.exe /a` executou, saída 1116, sem console) e o contorno `ShellExecuteW` foi removido. O `spawn` com `windowsHide` **não** detached ainda derruba o processo txiki com 0xC0000005 em qualquer `stdio` (`.empryo/tmp/spawn-probe.ts`), então `output()` mantém o contorno `CreateProcessW`. Continuam locais também o UTF-16LE do `Buffer` no txiki e as APIs DWM (thumbnails, Peek).

### Revalidação — limpeza e watchdog

- Removida a manipulação de `Symbol.for("tarve.packHost")`/`<version>.boot`. O `pack-host.js` instalado confirma o pack em saída 0 e preserva rollback em saída não zero. `exitApp` delega a `process.exit`; `onExit` usa `process.once("exit")`, com cancelamento via `process.off`, em todos os runtimes.
- Probe compilado txiki: `--exit` registrou `ON_EXIT_CLEANUP` e `EXIT_EVENT 0`; a janela registrou `READY`, `CLOSING`, `CLOSED`, `ON_EXIT_CLEANUP`, `EXIT_EVENT 0`. Portanto `app.close()` resolve `app.closed` em 0.13.2; removida a exceção txiki no encaminhamento de `--quit`. O gap histórico de `app.close()` não permanece nesse ensaio. Evidências: `.empryo/tmp/cleanup-probe.ts`, `cleanup-probe-exit.log` e `cleanup-probe-close.log`.
- AppBar continua via Win32: reportar falha de reserva e desfazer registro incompleto não resolve o roteamento para nossa `Shell_TrayWnd`, nem o posicionamento independente necessário a `stripOverlap`. A API pública 0.13.2 continua apenas `appBar(edge, { size })`; nenhuma troca por `app.appBar()` foi feita. Não se trata de homologação nova dessa API dentro do tray host.
- O watchdog recebe o HWND e envia `ABM_REMOVE` após a morte do processo, antes de restaurar o estado. Localiza somente a `Shell_TrayWnd` pertencente ao Explorer. A primeira captura usa criação exclusiva (`wx`) de `configDir/taskbar-state.json`; uma captura existente é reutilizada, inclusive após crash. Restore normal apaga o arquivo; restore do watchdog o preserva. Sem snapshot, o helper de uma saída normal não reaplica um estado antigo. A captura não consegue reconstruir retroativamente um estado que já estava sujo antes da primeira execução corrigida.
- Dois problemas adicionais de lançamento foram reproduzidos isoladamente: `Win32_ProcessStartup.CreateFlags` fez WMI responder 21, mesmo com valor 0; com apenas `ShowWindow=0`, respondeu 0. Além disso, PowerShell com `detached=true`/stdio ignorado saiu 0 sem executar a criação do helper (arquivo de resultado ausente); a mesma chamada sem `detached` criou o arquivo. Probe preservado em `.empryo/tmp/detached-probe.ts`. O launcher agora usa `output`, aguarda sua conclusão e valida `ReturnValue`; o watchdog criado por WMI continua independente da árvore do dock e oculto por `ShowWindow=0`.
- Baseline reproduzida: `.empryo/tmp/cleanup-before/results.json` reprovou kill em Bun/Node/dev (state=1, área útil até 1280). Ensaios intermediários foram mantidos em `cleanup-floating`, `cleanup-final-floating`, `cleanup-watchdog-debug` e `cleanup-watchdog-output`; não são os resultados finais.

Verificação final: `bun run typecheck`, `bun test scripts/runtime-portability.test.ts` (4 testes, 211 assertions) e builds txiki/Bun/Node passaram. Os builds finais foram executados sequencialmente. Ambos os comandos abaixo saíram 0:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-runtimes.ps1 -Mode floating -TestForcedExit -OutputDirectory .empryo/tmp/cleanup-verified-floating
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-runtimes.ps1 -Mode full -TestForcedExit -OutputDirectory .empryo/tmp/cleanup-verified-full
```

### Resultados automatizados

Tabela conferida nos `results.json` finais dos dois modos. OK vale somente para a medida descrita; autostart no dev não foi exercitado.

| Verificação (flutuante e completo) | txiki exe | Bun exe | Node exe | bun run dev |
|---|---|---|---|---|
| Processo vivo após 8 s e HWND/PID do dock | OK | OK | OK | OK |
| Reserva de área útil e Explorer oculto | OK | OK | OK | OK |
| `--quit`: dock encerra com saída 0 | OK | OK | OK | OK |
| Após quit: Explorer, state e área útil restaurados | OK | OK | OK | OK |
| Após kill: Explorer, state e área útil restaurados | OK | OK | OK | OK |
| Snapshot: removido no quit, original preservado no kill | OK | OK | OK | OK |
| `--autostart on/off`: registro e saída 0 | OK | OK | OK | não exercitado |
| `--update`: encaminhamento, dock continua vivo | OK | OK | OK | OK |
| Volume/COM, IImageList e Peek: teste funcional isolado | não exercitado | não exercitado | não exercitado | não exercitado |
| GUI: aparência e interações | pendente humano | pendente humano | pendente humano | pendente humano |
| Atualização real e migração entre runtimes | não exercitado | não exercitado | não exercitado | não exercitado |

Verificações complementares aprovadas na revalidação: typecheck, 4 testes de portabilidade (211 assertions), builds txiki/Bun/Node e probe txiki de saída/eventos descrito acima.

Em todas as oito amostras: `--quit` encerrou o dock original com saída 0; após quit e kill, Explorer visível, state=0 e área útil 0,0,2048,1232, sem recuperação emergencial. Durante execução, reserva flutuante até y=1200 e completa até y=1216; snapshot original preservado com valor 0 após kill e apagado na saída normal seguinte. `--autostart on/off` passou nos três exes; `--update` continuou sendo somente encaminhamento para feed indisponível. A aparência e interação visual continuam pendentes de homologação humana (`DockVisible=false` nesta sessão).

Evidências finais: `results.json` e logs por processo nos dois diretórios acima; `.empryo/tmp/cleanup-audit.json` registra auditoria às 17:31:23 +09:00 de 2026-11-17: DockPid=0, Explorer visível, state=0, área útil original, HKCU Run sem WindowsBar e nenhum WindowsBar/dev/watchdog restante. Nenhum processo iniciado por estes ensaios ficou de pé.


## Reexecução independente — pendências do juiz (Tarve 0.13.2)

Em 2026-11-17, foram reexecutados exatamente os três pontos sem comprovação nova. Não foi necessária alteração no código da aplicação. Evidências novas em `.empryo/tmp/upgrade-0132-recheck/`; os resultados anteriores foram preservados.

- `bun run build:bun` e `bun run build:node`: saída 0, sequenciais; log em `build-bun-node.log`.
- Probe de ponteiro cru recompilado por `bunx tarve build .empryo/tmp/upgrade-0132-recheck/pointer-probe.ts --runtime <txiki|bun|node> --outfile .empryo/tmp/upgrade-0132-recheck/pointer-<runtime>.exe` e executado nos três runtimes: saída 0 e `result=PASS` em cada `pointer-<runtime>.log`. O probe usa `GetProcAddress` e a fachada `CFunction` real: GetTickCount, f64/buffer de saída, ponteiro bigint, f32, retorno ptr/null, precisão i64, args padrão, assinatura não suportada, endereço inválido e close idempotente. Fonte e log dos builds preservados. Não equivale a teste funcional de COM, IImageList ou Peek.
- Ambos os smokes abaixo: saída 0, quatro runtimes por modo (txiki/Bun/Node/dev), oito amostras aprovadas. Conferidos `results.json`: reserva e Explorer oculto durante execução; quit com saída 0; barra, state=0 e área útil original restaurados após quit e kill, antes de recuperação emergencial; snapshot removido no quit e preservado com valor 0 no kill.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-runtimes.ps1 -Mode floating -TestForcedExit -OutputDirectory .empryo/tmp/upgrade-0132-recheck/floating
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-runtimes.ps1 -Mode full -TestForcedExit -OutputDirectory .empryo/tmp/upgrade-0132-recheck/full
```

`audit-before.json` e `audit-after.json` comprovam DockPid=0, Explorer visível, state=0, área útil `0,0,2048,1232`, autostart ausente e nenhum WindowsBar/dev/watchdog remanescente; auditoria final às 17:39:11 +09:00. `DockVisible=false` nas oito amostras: GUI continua pendente de homologação humana. Nenhum stash/reset/checkout foi usado.

### Nova execução nesta revisão do juiz

Execução de 2026-11-17, entre 17:41:41 e 17:45:13 +09:00; evidências novas em `.empryo/tmp/upgrade-0132-judge-rerun/`, sem reutilizar resultados anteriores:

- `bun run build:bun` e `bun run build:node`: aprovados, saída 0; `build-bun.log` e `build-node.log`.
- `pointer-probe.ts` copiado integralmente do ensaio anterior, recompilado e executado em txiki, Bun e Node: três saídas 0, dez verificações por runtime e `result=PASS`; `build-pointer-probes.log` e `pointer-{txiki,bun,node}.log`.
- `scripts/smoke-runtimes.ps1 -Mode floating -TestForcedExit -OutputDirectory .empryo/tmp/upgrade-0132-judge-rerun/floating` e o mesmo comando com `-Mode full` e diretório `full`: duas saídas 0. Cada modo exercitou txiki/Bun/Node/dev, totalizando oito amostras; `smoke-floating.log`, `smoke-full.log` e os dois `results.json`.
- Conferidos os oito resultados: dock vivo, área reservada (flutuante y=1200; completo y=1216), Explorer oculto, encaminhamento de update com saída 0, quit com saída 0, restauração após quit e kill (Explorer visível, state=0, área útil `0,0,2048,1232`) antes de recuperação emergencial; snapshot removido no quit e preservado com valor 0 no kill.
- `audit-before.json` e `audit-after.json`: DockPid=0, Explorer visível, state=0, mesma área útil, autostart ausente e nenhum processo WindowsBar/dev/watchdog restante.

Sem alteração no código da aplicação, sem refactors e sem stash/reset/checkout. `DockVisible=false` permanece nas oito amostras: estes ensaios não homologam aparência/interações da GUI, nem atualização real, COM, IImageList ou Peek.

### Reexecução solicitada após o verdict PARTIAL

Em 2026-11-17, entre 17:50:53 e 17:53:30 +09:00, os três pontos foram reexecutados nesta revisão, com evidências novas em `.empryo/tmp/upgrade-0132-current-review/`:

- Builds `bun run build:bun` e `bun run build:node`: saída 0, sequenciais; `build-bun.log` e `build-node.log`.
- Probe `pointer-probe.ts` recompilado e executado em txiki/Bun/Node: saída 0 e `result=PASS`, dez verificações por runtime. O executor aguarda o processo real terminar e captura stdout/stderr explicitamente; não infere sucesso apenas do lançamento do exe. Fontes, exes e `pointer-{txiki,bun,node}.log` preservados.
- Smokes `-TestForcedExit` nos modos `floating` e `full`: saída 0 em ambos, txiki/Bun/Node/dev, oito amostras. Os dois `results.json` foram conferidos: dock vivo, área reservada, Explorer oculto; quit com saída 0; Explorer, state=0 e área útil original restaurados após quit e kill antes da recuperação emergencial; snapshot removido no quit e preservado com valor 0 no kill.

`verify.ps1` reproduz os comandos; `verification.json` registra início, fim e saída de cada etapa. Os logs redirecionados pelo Windows PowerShell usam UTF-16LE. Typecheck e os quatro testes de portabilidade (211 assertions) também foram reexecutados e aprovados. Não foi necessário alterar código da aplicação; sem refactors, stash/reset/checkout. `DockVisible=false` nas oito amostras: homologação visual e testes funcionais de COM/IImageList/Peek continuam fora desta verificação.
