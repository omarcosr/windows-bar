# Regras do projeto windows-bar

## Regra principal: seguir o padrão do Windows
O dock substitui a barra de tarefas do Windows. Todo comportamento que a barra do Windows já tem deve usar **o mesmo mecanismo e a mesma fonte de dados que ela**, não uma imitação nem uma alternativa própria.

- **Dados:** leia do mesmo lugar que o Explorer (apps fixados = `User Pinned\TaskBar` + `Taskband\Favorites`; identidade do app = AppUserModelID da janela/pacote; ícones = os do shell para aquele item, inclusive o logo do pacote MSIX; preferências = registro da barra).
- **Ações:** use as APIs/comandos do shell que a barra usa (ShellExecute do `.lnk` fixado, `WM_SYSCOMMAND` para minimizar/restaurar, comandos do `Shell_TrayWnd`, URIs `ms-actioncenter:`/`ms-settings:`, verbos do shell). Nunca simule teclado (`keybd_event`/`SendInput`) quando existir o caminho nativo: isso causa efeitos colaterais (retângulos de foco/outline).
- **Visual:** ícones desenhados como o Windows desenha (tamanho no frame certo, pixels físicos inteiros, sem reescala).
- Antes de implementar algo que a barra do Windows já faz, descubra **como o Windows faz** e replique. Se o mecanismo do Windows estiver bloqueado para terceiros, diga isso explicitamente e pergunte antes de criar uma alternativa própria.

## Só considerar corrigido o que for realmente testado
Uma correção só conta como feita depois de reproduzir o problema e ver, rodando o dock, que ele não acontece mais (cliques reais, janelas reais, medição). Typecheck e testes unitários não bastam. O que não puder ser testado deve ser dito como **não testado**, nunca como corrigido.
