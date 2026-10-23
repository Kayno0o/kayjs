use zed_extension_api::{self as zed, LanguageServerId, Result};

struct KayExtension;

impl zed::Extension for KayExtension {
    fn new() -> Self {
        KayExtension
    }

    // The project's own kay answers when it is on the PATH, else bunx runs the one the project installed.
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
