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
| `WindowsBar-<v>-win32-x64-bun.tarve` | Pacote do app sem o runtime (~150 KB): a atualização incremental |
| `WindowsBar-<v>-win32-x64.exe` | Executável completo, baixado só quando o pacote não serve |
| `latest.json` | Manifesto assinado que o app consulta (enviado por último) |

O executável é gerado com `--packs --trim`. Uma cópia instalada baixa só o `.tarve` quando a nova versão roda no mesmo executável (mesma versão do Tarve e mesmas funções nativas); se não, baixa o executável inteiro. Os pacotes ficam em `%LOCALAPPDATA%\WindowsBar.Dock\packs`.

Para testar contra um servidor local: `bun run release 0.2.0 --out <pasta> --base-url http://localhost:8765/`, sirva `<pasta>\updates` e rode a cópia instalada com `WINDOWSBAR_UPDATE_URL=http://localhost:8765/latest.json`; `WindowsBar.exe --update` procura, baixa e instala na hora.

## Chave de assinatura

As atualizações são assinadas com Ed25519. A chave privada fica em `windows-bar-update.key` (gerada com `bunx tarve keygen`, fora do git) e no secret `TARVE_UPDATE_PRIVATE_KEY` do repositório; a chave pública está em `src/services/updater.ts` e `scripts/release.ts`.

```powershell
Get-Content -Raw windows-bar-update.key | gh secret set TARVE_UPDATE_PRIVATE_KEY --repo omarcosr/windows-bar
```

Guarde um backup da chave: sem ela, as cópias instaladas não aceitam novas versões.

## Release local

```powershell
bun run release 0.2.0             # dist/release (instalador e zip) e dist/updates (exe e latest.json)
bun run release 0.2.0 --publish   # o mesmo, e cria o release v0.2.0 com o gh
```

Feche o WindowsBar que estiver rodando de `dist\WindowsBar.exe` antes: o arquivo fica em uso.

O instalador é configurado em `tarve.installer` no `package.json`: ele roda `WindowsBar.exe --quit` antes de instalar ou desinstalar e `--autostart on|off` para a opção de iniciar com o Windows.
