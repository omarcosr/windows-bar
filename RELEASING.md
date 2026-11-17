# Publicando versões

Os releases são gerados pelo GitHub Actions (`.github/workflows/release.yml`) com o instalador, o empacotamento e o updater do Tarve.

## Publicar

1. Atualize `version` no `package.json` e faça o commit.
2. Crie e envie a tag:

   ```powershell
   git tag v0.2.0; git push origin v0.2.0
   ```

   Ou use **Actions → release → Run workflow** informando a versão.

O workflow publica em Releases:

| Arquivo | Para quê |
| --- | --- |
| `WindowsBar-Setup-<v>-win32-x64.exe` | Instalador (por usuário, em `%LOCALAPPDATA%\Programs\WindowsBar`) |
| `WindowsBar-<v>-windows-x64.zip` | Versão portátil |
| `WindowsBar-<v>-win32-x64-<runtime>.tarve` | Pacote incremental do runtime escolhido (`txiki`, `bun` ou `node`) |
| `WindowsBar-<v>-win32-x64.exe` | Executável completo, baixado só quando o pacote não serve |
| `latest.json` | Manifesto assinado que o app consulta (enviado por último) |

O executável é gerado com `--packs`; `--trim` é aplicado somente ao Bun. Uma cópia instalada baixa só o `.tarve` quando a nova versão roda no mesmo executável (mesmo runtime, versão do Tarve e funções nativas). **Trocar de runtime baixa o executável inteiro na primeira atualização**; as seguintes podem voltar a usar packs compatíveis. Os pacotes ficam em `%LOCALAPPDATA%\WindowsBar.Dock\packs`.

Com Tarve 0.13.2, a confirmação do pack é responsabilidade do pack host: saída 0 durante a inicialização confirma o pack; crash ou saída não zero nos primeiros 3 s mantém o rollback. O app não manipula mais `tarve.packHost` nem arquivos `<version>.boot`. A troca de 0.13.0 para 0.13.2 requer executável compatível novo; os smokes de `--update` não homologam download, instalação, reinício ou migração de runtime.

`--runtime txiki|bun|node` seleciona o runtime (padrão: `txiki`) no build, pack e instalador. Antes da publicação, o pack local chama-se `WindowsBar-<runtime>.tarve`; em `updates/`, recebe versão e plataforma conforme a tabela. Instalador, zip e exe têm os mesmos nomes nos três runtimes: use pastas `--out` separadas e publique apenas um runtime por versão/feed, para evitar sobrescrita.

No workflow manual, selecione o input **runtime**; tags usam `txiki`. O runner instala Bun, Node 26.10.0 e txiki 26.6.0. A troca de runtime descreve a seleção esperada do updater; instalação e migração reais ainda não foram homologadas. Consulte os resultados automatizados com Tarve 0.13.2 e as validações humanas pendentes em [STEP7-RUNTIME-TESTS.md](STEP7-RUNTIME-TESTS.md#tarve-0132) antes de distribuir qualquer runtime.

Para testar contra um servidor local: `bun run release 0.2.0 --out <pasta> --base-url http://localhost:8765/`, sirva `<pasta>\updates` e rode a cópia instalada com `WINDOWSBAR_UPDATE_URL=http://localhost:8765/latest.json`; `WindowsBar.exe --update` procura, baixa e instala na hora.

Ensaio local dos três runtimes, verificações e limitações: [STEP8-RELEASE-TESTS.md](STEP8-RELEASE-TESTS.md).

## Chave de assinatura

As atualizações são assinadas com Ed25519. A chave privada fica em `windows-bar-update.key` (gerada com `bunx tarve keygen`, fora do git) e no secret `TARVE_UPDATE_PRIVATE_KEY` do repositório; a chave pública está em `src/services/updater.ts` e `scripts/release.ts`.

```powershell
Get-Content -Raw windows-bar-update.key | gh secret set TARVE_UPDATE_PRIVATE_KEY --repo omarcosr/windows-bar
```

Guarde um backup da chave: sem ela, as cópias instaladas não aceitam novas versões.

## Release local

Pré-requisitos: Windows x64, dependências instaladas com `bun install`, Bun 1.3+ no PATH e chave de assinatura. Para txiki, instale com `winget install Saghul.TxikiJS` (reabra o terminal) ou defina `TARVE_TXIKI` como caminho do `tjs.exe`. Para Node, instale Node 26.10+ no PATH; o FFI é experimental, habilitado no exe compilado. O CLI de release continua sendo executado pelo Bun em todos os casos.

```powershell
bun run release 0.2.0 --runtime txiki --out "$env:TEMP\WindowsBar-release\txiki"
bun run release 0.2.0 --runtime bun --out "$env:TEMP\WindowsBar-release\bun"
bun run release 0.2.0 --runtime node --out "$env:TEMP\WindowsBar-release\node"
bun run release 0.2.0 --runtime txiki --publish # publica no GitHub com gh
```

Sem `--publish`, nada é enviado ao GitHub. Sem `--out`, usa `dist`: `release/` contém instalador e zip, `updates/` contém exe, pack e `latest.json` assinado. Sem chave o script interrompe antes do build; não gere uma chave nova para atualizar instalações existentes.

**A versão posicional altera `package.json`.** Em um ensaio, anote a versão original e restaure somente esse campo ao terminar (inclusive se houver falha), preservando outras alterações locais. Para manter a versão atual, omita `0.2.0`.

Feche o WindowsBar que estiver rodando de `dist\WindowsBar.exe` antes: o arquivo fica em uso.

O instalador é configurado em `tarve.installer` no `package.json`: ele roda `WindowsBar.exe --quit` antes de instalar ou desinstalar e `--autostart on|off` para a opção de iniciar com o Windows.
