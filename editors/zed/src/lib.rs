use zed_extension_api::{self as zed, LanguageServerId, Result};

// Where the project's own kay keeps its command line, from the worktree's root.
const PROJECT_CLI: &str = "node_modules/kay/src/cli.ts";

struct KayExtension;

impl zed::Extension for KayExtension {
    fn new() -> Self {
        KayExtension
    }

    // A kay on the PATH answers first, else bun runs the one the project installed, else bunx fetches one.
    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let env = worktree.shell_env();
        let serve = ["lsp", "--stdio"].map(String::from);

        if let Some(kay) = worktree.which("kay") {
            return Ok(zed::Command { command: kay, args: serve.to_vec(), env });
        }

        if worktree.read_text_file(PROJECT_CLI).is_ok() {
            if let Some(bun) = worktree.which("bun") {
                let cli = format!("{}/{}", worktree.root_path(), PROJECT_CLI);

                return Ok(zed::Command {
                    command: bun,
                    args: [cli].into_iter().chain(serve).collect(),
                    env,
                });
            }
        }

        let bunx = worktree
            .which("bunx")
            .ok_or_else(|| "kay is not on the PATH and neither is bunx, install kay in the project or Bun".to_string())?;

        Ok(zed::Command {
            command: bunx,
            args: ["kay".to_string()].into_iter().chain(serve).collect(),
            env,
        })
    }
}

zed::register_extension!(KayExtension);
