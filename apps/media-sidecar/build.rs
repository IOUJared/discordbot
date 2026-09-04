//! Compile-time provenance for the sidecar version report.

#![allow(
    clippy::print_stdout,
    reason = "Cargo build scripts must emit directives on standard output"
)]

use std::{env, fs, process::Command};

fn command_output(program: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new(program).args(arguments).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_owned())
}

fn main() {
    let rustc = env::var("RUSTC").unwrap_or_else(|_| String::from("rustc"));
    let rustc_version = command_output(&rustc, &["--version"])
        .unwrap_or_else(|| String::from("rustc version unavailable"));
    let build_revision = command_output("git", &["rev-parse", "--short=12", "HEAD"])
        .unwrap_or_else(|| String::from("unknown"));

    println!("cargo:rustc-env=SIDECAR_RUSTC_VERSION={rustc_version}");
    println!("cargo:rustc-env=SIDECAR_BUILD_REVISION={build_revision}");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    if let Ok(head) = fs::read_to_string("../../.git/HEAD")
        && let Some(reference) = head.trim().strip_prefix("ref: ")
    {
        println!("cargo:rerun-if-changed=../../.git/{reference}");
    }
}
