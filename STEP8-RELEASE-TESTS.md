# STEP 8 — release local e documentação

## Ambiente e escopo

Windows x64, Bun 1.4.4, Node 26.10.0, txiki 26.6.0 e Tarve 0.13.0. Releases de ensaio 0.2.0 executados sem `--publish`. A chave `windows-bar-update.key` existia; nenhum segredo foi exibido ou alterado. Não houve upload, commit, instalação nem atualização de uma cópia do usuário.

## Comandos executados

```powershell
bun run release 0.2.0 --runtime txiki --out "$env:EMPRYO_TMP\step8-release\txiki"
bun run release 0.2.0 --runtime bun --out "$env:EMPRYO_TMP\step8-release\bun"
bun run release 0.2.0 --runtime node --out "$env:EMPRYO_TMP\step8-release\node"
```

Os três comandos concluíram build, pack, instalador, zip e manifesto assinado (Bun e Node foram além do mínimo solicitado, até o release completo). A versão original de `package.json`, **0.1.0**, foi restaurada alterando somente o campo version.

| Runtime | Build, pack, setup e zip | Assinatura Ed25519 e SHA-256 | Exe (bytes) | Pack (bytes) |
| --- | --- | --- | ---: | ---: |
| txiki | OK | OK | 14.008.222 | 320.065 |
| Bun | OK | OK | 105.494.016 | 310.615 |
| Node | OK | OK | 124.176.384 | 310.616 |

A verificação independente de `latest.json` validou assinatura contra a chave pública do app, versão, runtime do pack, tamanhos e hashes do exe/pack. Também verificou existência/tamanho positivo do instalador e zip. O próprio `tarve release --public-key` havia verificado o manifesto durante a geração.

## Documentação e workflow

- `README.md`: tabela de runtimes para dev/build, requisitos, txiki build-only, limites Node/FFI e pendências txiki do STEP 7.
- `RELEASING.md`: artefatos por runtime, instalação txiki via winget, Node 26.10+, `--runtime`, separação de pastas/feeds e download completo na primeira troca de runtime.
- `.github/workflows/release.yml`: input runtime (txiki padrão), Node 26.10.0 e txiki 26.6.0 instalados. Download oficial fixado no txiki testado; não depende da disponibilidade de winget no runner. Inputs de versão passam por variável de ambiente e validação, não interpolação no shell.
- YAML parseado com Bun.YAML; opções/default e versão Node conferidos. O bloco PowerShell de instalação txiki foi executado localmente com sucesso em pasta isolada e retornou v26.6.0. O workflow não foi disparado no GitHub.
- `bun run typecheck`: OK. `bun test scripts/runtime-portability.test.ts`: 3 testes, 208 assertions, sem falhas.

## Limites e tentativas intermediárias

Invocações diretas com caminho de chave foram bloqueadas pelo filtro de arquivos secretos da ferramenta. Tentativa sem chave com `build --packs` foi recusada pelo Tarve, como esperado. Os releases completos acima foram executados pelo script existente; sem mudanças em `scripts/release.ts` ou nas chaves.

Gerar os artefatos não homologa execução/instalação/atualização. Não foi exercitada migração real Bun → txiki; o download do exe completo é o comportamento esperado quando não há pack compatível. A revalidação final do [STEP7-RUNTIME-TESTS.md](STEP7-RUNTIME-TESTS.md) aprovou no txiki, nos modos flutuante e completo, a ocultação da barra nativa, o encerramento por `--quit` e a restauração da barra, do estado de auto-hide e da área útil após `--quit` e kill deliberado, sem fallback emergencial. Volume COM e Aero Peek no txiki e as limitações Node permanecem; a GUI ainda requer validação humana. Essa aprovação vem do smoke final do STEP 7, não deste ensaio de release.

## Evidências locais

Raiz: `.empryo/tmp/tabs/t_mwjjn49f_1s73693c3d6a_8/step8-release/`.

- `txiki/`, `bun/` e `node/`: cada pasta contém exe, pack, `release/` (setup/zip) e `updates/` (manifesto/exe/pack).
- `verify.mjs`: oráculo independente das assinaturas, hashes, tamanhos, versão restaurada e inputs YAML; execute com Bun a partir da raiz do projeto.
- `verify-ci-install.ps1` e `ci-install/`: ensaio do bloco de instalação txiki do CI, sem executar publicação.
