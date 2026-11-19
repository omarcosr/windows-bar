# Gaps em relação à barra de tarefas do Windows

Funcionalidades da barra nativa do Windows 11 que o dock ainda não suporta.
Regra do projeto (EMPRYO.md): usar o **mesmo mecanismo e a mesma fonte de dados** do Explorer, e só marcar como feito o que foi **testado rodando o dock**. O que não pôde ser testado fica marcado como `não testado`.

Legenda: `[ ]` pendente · `[~]` implementado, não testado · `[x]` implementado e testado · `[!]` bloqueado pelo Windows

## 1. Jump list (agente: jump-list)
- [x] Itens recentes/frequentes do app (`AutomaticDestinations` / `IApplicationDestinations` / `IApplicationDocumentLists` pelo AppUserModelID)
- [x] Itens fixados e categorias personalizadas (`CustomDestinations`, `ICustomDestinationList`)
- [x] Tarefas do app (seção "Tarefas")
- [x] Fixar/desafixar item na jump list
  - AppID via `IApplicationResolver` (janela ou `.lnk` fixado); lista automática via `IAutomaticDestinationList` e lista do app via `IInternalCustomDestinationList` (interfaces internas do shell, as mesmas do Explorer). Testado no dock: Chrome (Fixado, Mais visitados, Fechadas recentemente, Tarefas, favicons), VS Code (Recent Folders, Recentes, Tarefas), fixar/desafixar GitHub pelo botão do item e abrir a tarefa "Nova janela anônima".
  - Não testado: app fixado no dock **sem** janela aberta e sem `.lnk` (AppID padrão montado com o GUID da pasta conhecida); app com categoria "Frequentes"; Start_TrackDocs=0.
- Arquivos: novo `src/native/jump-list.ts`, seção nova em `showMenu` de `src/widgets/builtin/apps.tsx`

## 2. Cliques com modificadores (agente: click-modifiers)
- [x] Shift+clique e clique do meio → nova instância
- [~] Ctrl+Shift+clique → executar como administrador (verbo `runas`) — não testado (o prompt do UAC fica na área de trabalho segura)
- [x] Ctrl+clique → alternar entre as janelas do app
- [x] Shift+clique direito → menu de sistema da janela (`WM_POPUPSYSTEMMENU`, como o Explorer posta; grupo: restaurar/minimizar/fechar todas via `WM_SYSCOMMAND`)
- Arquivos: `AppIcon` em `src/widgets/builtin/apps.tsx`, `src/services/windows.ts`

## 3. Teclado (agente: keyboard)
- [!] Win+1..9 (ativar/abrir o N-ésimo app), Win+Shift+N, Win+Alt+N
- [!] Win+T (foco nos botões de app e navegação por setas)
- [!] Win+B (foco na bandeja)
- Testado: com o Explorer rodando, `RegisterHotKey(MOD_WIN[|SHIFT|ALT], '1'..'9'|'T'|'B')` falha em todos com `ERROR_HOTKEY_ALREADY_REGISTERED` (1409); controle Win+Ctrl+F12 registra OK. O Explorer registra esses atalhos na própria barra (`Shell_TrayWnd`) e não há API para recebê-los. Caminhos possíveis, todos alternativos e pendentes de decisão: valor `DisabledHotkeys` em `Explorer\Advanced` (faz o Explorer não registrar as letras/dígitos; exige reiniciar o Explorer e vale mesmo com o dock fechado) ou hook `WH_KEYBOARD_LL` (intercepta, não é o mecanismo do Explorer).
- Arquivos: novo `src/native/hotkeys.ts`, inicialização em `src/main.tsx`
- Observação: o Explorer reserva esses atalhos; verificar se `RegisterHotKey` é possível ou se há outro caminho nativo. Se bloqueado, marcar `[!]` e explicar.

## 4. Áreas de trabalho virtuais (agente: virtual-desktops)
- [x] Mostrar só janelas da área de trabalho atual (`IVirtualDesktopManager::IsWindowOnCurrentVirtualDesktop`), seguindo a preferência `VirtualDesktopTaskbarFilter`
- [~] Atualizar ao trocar de área de trabalho (evento, não polling) — testado: janela movida entre áreas e área removida (EVENT_OBJECT_CLOAKED/UNCLOAKED) e troca da preferência (watch do registro); não testado: o usuário trocando de área (Win+Ctrl+setas) e clique num botão de janela de outra área
- Arquivos: `src/services/windows.ts`, `src/native/win32.ts`

## 5. Vários monitores (agente: multi-monitor)
- [~] Preferência `MMTaskbarEnabled` / `MMTaskbarMode` (barra em todas as telas; botões onde a janela está aberta) — lida de `Explorer\Advanced` e observada pelo watch "advanced" (`taskbar-prefs.ts`, testado: lê `1`/`2`); com modo 2 o dock (no lugar da barra principal, tela primária) lista só as janelas da tela primária (`windows.ts` `refreshWindows`, via `MonitorFromWindow`), relistando em "moved" e em mudança da preferência. Testado só com 1 monitor (nenhuma janela some); o filtro em 2+ monitores **não testado**.
- [ ] Dock por monitor
  - Plano: (1) `DockWindow` por monitor — hoje é singleton (`#current`, `handle()`, `placePopup`, `pointerOn`); virar instâncias com `hmonitor` e popups ancorados na instância clicada. (2) Uma janela Tarve por monitor (como os popups de `initDockMenu`), cada uma com seu AppBar `ABE_*` naquela tela, criadas/destruídas em `app.onScreensChange`. (3) Esconder `Shell_SecondaryTrayWnd` da tela coberta (hoje só `Shell_TrayWnd` é escondido; o auto-hide de `ABM_SETSTATE` vale para todas) e restaurá-los no watchdog. (4) Lista por tela conforme `MMTaskbarMode` (0 todas; 1 principal tudo + secundária só as suas; 2 só as suas); a tray/relógio só na principal, como o Explorer (secundária mostra só relógio). (5) Só com `MMTaskbarEnabled=1`; com 0 as telas secundárias ficam sem barra.
- Arquivos: `src/native/dock-window.ts`, `src/main.tsx`
- Observação: mudança grande; se não couber, entregar a análise e o primeiro passo.

## 6. Ocultar automaticamente (agente: auto-hide)
- [!] Dock se esconde/revela como a barra (`ABS_AUTOHIDE` em `StuckRects3`, revelação na borda)
  - Bloqueio (medido com o dock rodando): para esconder a barra do Explorer na borda inferior sem que ela reserve a faixa, o dock a põe em `ABS_AUTOHIDE` (`#hiddenState`). Com isso o `Shell_TrayWnd` do Explorer ocupa o único slot de AppBar auto-oculta da borda inferior (`ABM_GETAUTOHIDEBAREX` devolve o HWND dele), então `ABM_SETAUTOHIDEBAREX` do dock falha; e `ABM_GETSTATE`/`StuckRects3` (byte 8 = 3) passam a refletir o estado forçado pelo dock, não a preferência do usuário (desligar em Configurações é desfeito pelo `#rehideTaskbar`). A preferência real só existe no snapshot `taskbar-state.json`.
  - Precisa de decisão antes de implementar: como esconder a barra do Explorer na borda inferior sem tomar o slot de auto-ocultar dela (ex.: cobrir a faixa como já é feito nas bordas laterais/topo).
- Arquivos: `src/native/dock-window.ts`, `src/services/taskbar-prefs.ts`

## 7. Prévia: botões de miniatura (agente: thumbbar)
- [x] Botões `ITaskbarList3::ThumbBarAddButtons/UpdateButtons/SetImageList` na prévia, com clique enviando `WM_COMMAND` + `THBN_CLICKED`
  - Mecanismo medido (Win11 26340): chegam ao `MSTaskSwWClass` como `WM_USER+0x4C` (Add), `+0x4D` (Update), `+0x4E` (ImageList, stream do `ImageList_Write`), `+0x50` (Tooltip), `+0x51` (Clip); wParam = janela, lParam = bloco `SHAllocShared` feito para o processo dono da task band (o dock), liberado pelo app ao receber a resposta; resposta 0 faz a chamada falhar com `ERROR_TIMEOUT`. Por isso não são repassadas ao Explorer e o dock responde 1 depois de ler o bloco (`waitReplies`).
  - Testado com o dock rodando e um app de teste (imagelist + hIcon): botões aparecem, dica do botão, clique → `WM_COMMAND id=103 code=0x1800`, Update troca ícone/dica ao vivo, `THBF_DISABLED` esmaece. Não testado: `THBF_HIDDEN`, `THBF_DISMISSONCLICK`, `THBF_NOBACKGROUND`/`NONINTERACTIVE`.
- [x] Recorte `SetThumbnailClip` e tooltip `SetThumbnailTooltip`
  - Testado: a miniatura mostra só o retângulo da área cliente; o tooltip aparece no cabeçalho do card enquanto o ponteiro está na miniatura (o Explorer usa um tooltip flutuante; aqui é o título do card). Não testado: limpar com `NULL` (lParam 0 assumido).
- Arquivos: `src/native/tray-host.ts`, `src/services/taskbar-host.ts`, `src/menu/window-preview.tsx`

## 8. Rótulos e agrupamento (agente: labels)
- [x] `TaskbarGlomLevel` lido de `Explorer\Advanced` (watcher do registro, sem polling) e aplicado ao vivo: 0 sempre combinar (ícones), 2 nunca (um botão por janela com ícone + título, estreitando e depois "•••"), 1 quando cheio (rótulos enquanto cabem, combina quando não cabem) — testado rodando o dock com 0/1/2
- [~] Caso "cabe tudo" (rótulo com até 4 slots) e o modo 1 mostrando rótulos — não testado (havia janelas demais para caber)
- [~] Clique no botão rotulado ativa a janela / minimiza a que está na frente (`activateWindowButton`), menu de contexto e indicador ativo por janela (`desktop.activeHwnd`) — não testado
- [~] `MMTaskbarGlomLevel` lido em `taskbarPrefs.mmGlom`, mas não aplicado: o dock só existe no monitor principal (depende da seção 5) — não testado
- [~] Largura máxima do botão rotulado (4 slots) estimada, não medida na barra do Explorer (ela fica oculta pelo dock)
- Arquivos: `src/services/taskbar-prefs.ts`, render em `src/widgets/builtin/apps.tsx`

## 9. Arrastar e soltar (agente: drag-drop)
- [x] Arquivo arrastado sobre o botão ativa a janela do app depois do tempo de hover do sistema (`SPI_GETMOUSEHOVERTIME`, 400 ms; o mesmo que o Explorer espera), restaurando se minimizada — medido com arrasto OLE real (DoDragDrop + SendInput de mouse) no Chrome: barra nativa 398–421 ms, dock antes 982 ms (constante de 1 s), dock agora 380–406 ms
- [x] App com várias janelas: abre as miniaturas (sem trocar de janela), como a barra; arquivo parado sobre uma miniatura traz aquela janela (`dragOverApp`/`dragOverCard` em `window-preview.tsx`) — medido no Explorer com 3 janelas: miniaturas em +424–442 ms (nativo: miniaturas, nenhuma troca); troca pela miniatura 250–810 ms (nativo 855–874 ms)
- [x] Drop no ícone com o Chrome aberto: arquivo aberto em 202–282 ms (`dropFilesOn` leva 21–26 ms, depois que o Drop do Tarve volta à origem). A barra nativa recusa drop no botão (DROPEFFECT_NONE)
- [~] Drop com o Chrome fechado (partida a frio) — não testado (não fechei o Chrome do usuário)
- [x] Soltar arquivo no ícone abre com o app: o drop é repassado ao `IDropTarget` do shell do item fixado (`.lnk`/exe), como o Explorer — testado (arquivo abriu no VS Code pelo `.lnk` fixado; notepad.exe direto também)
- [!] Fixado de app empacotado (`shell:AppsFolder\<AUMID>`): o shell não expõe `IDropTarget` para esses itens (`E_NOINTERFACE`), então o drop não faz nada; alternativa seria `IApplicationActivationManager::ActivateForFile` (não implementada, aguarda decisão)
- Arquivos: novo `src/native/drop-target.ts` (OLE `RegisterDragDrop`), `src/widgets/builtin/apps.tsx`, `src/menu/window-preview.tsx`, `src/native/win32.ts` (`mouseHoverTime`)

## 10. Bandeja: notificações (agente: tray-balloons)
- [x] Balões `NIF_INFO` dos ícones hospedados (exibir como o Windows: notificação do sistema) — o host repassa o `WM_COPYDATA` inteiro (inclusive a identidade do app que o shell32 anexa no `NIM_ADD`) ao `Shell_TrayWnd` do Explorer, que mostra o toast do Win11 e manda `NIN_BALLOONSHOW`/`TIMEOUT`/`USERCLICK` ao app; testado com o dock rodando
- Arquivos: `src/native/tray-host.ts`, `src/widgets/builtin/tray.tsx`

## 11. Botões do sistema (agente: system-buttons)
- [!] Visão de Tarefas (`ShowTaskViewButton`) — o botão do Explorer chama interfaces internas do twinui (`WindowsInternal.ComposableShell.Experiences.Switcher.TaskView`, sem API pública). Os caminhos documentados não abrem nada no build 26340, mesmo com clique real e direito de primeiro plano: `IShellDispatch5::WindowSwitcher`, `shell:::{3080F90E-D7AD-11D9-BD98-0000947B0257}` e `ms-taskswitcher:` (este último dá erro). Restaria Win+Tab simulado (proibido) ou UIA Invoke no botão oculto da barra nativa: decidir antes de implementar
- [~] Pesquisa (`SearchboxTaskbarMode`: ícone, caixa, ícone+rótulo) — já existe (`launcher-search`, "Seguir o Windows" lê `SearchboxTaskbarMode` em `taskbar-prefs.ts` e vigia a chave no registro, sem polling). O clique abre o Iniciar (`SC_TASKLIST`), não o painel de Pesquisa (SearchHost), cujo mecanismo é interno. Não testado no dock
- [!] Copilot (se presente no sistema) — ausente neste sistema: não há `ShowCopilotButton`, pacote Copilot nem protocolo `ms-copilot:`. No 24H2+ o botão foi removido e o Copilot virou um app comum, que já aparece como app fixado
- Arquivos: `src/widgets/builtin/actions/shell-actions.tsx`, `src/services/taskbar-prefs.ts`

## Backlog (sem agente agora)
- [ ] Compartilhar janela (`ITaskbarList4`, Teams)
- [ ] UI Automation do próprio dock (acessibilidade): depende do framework `@tarve/core`
- [!] Fixar na barra do Windows a partir do dock: o Windows bloqueia o verbo `taskbarpin` para terceiros
- [x] Reordenar fixados arrastando: o botão arrastado para o lado muda de lugar, com a barra azul marcando onde cai (testado no dock com arrastos reais: reordena, a ordem sobrevive ao reinício, clique simples ainda ativa/minimiza, a prévia não abre durante o arrasto, o widget inteiro não se move, arrastar arquivo sobre o ícone ainda traz a janela). A ordem fica no próprio dock (`order` na config do widget de apps), não na barra do Windows: o Explorer guarda a ordem dos fixados na memória e grava `Taskband\Favorites` sozinho, e `IPinnedList3` não tem operação de mover, então terceiros não conseguem reordenar os fixados do Windows. Não testado: botões por janela (modo "nunca combinar", `WindowButton`).
