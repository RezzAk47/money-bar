//! The only file access the webview has: operations on a fixed set of names inside the data folder, plus one export of a
//! CSV file to a path the user picked in the save dialog. Names are validated (no separators, no `..`, only entries.json,
//! its two backups and its `.broken-` copies), the folder is
//! canonicalised, writes are atomic (temp file in the same folder, fsync, rename, fsync of the folder), and a symlinked
//! file keeps being a link (the real file behind it is replaced).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

/// What a file looked like when it was last read or written: size, modification time, change time and inode. A compare-and-swap
/// write goes through only if the file still has exactly this stamp (an editor that replaces the file changes the inode and the
/// change time even when size and modification time are equal). Times are WHOLE MICROSECONDS since the epoch (integers, below 2^53
/// until the year 2255) and the inode a decimal string, so the stamp survives Rust -> JSON -> page -> JSON -> Rust bit for bit; the
/// earlier fractional-millisecond floats did not (about 11% were off in the last bit) and caused false conflicts.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub size: u64,
    pub mtime_us: i64,
    pub ctime_us: i64,
    pub ino: String,
    /// FNV-1a 64 of the content as 16 hex digits ("" when it could not be read or the file is too big). FAT/exFAT keep modification
    /// times to 2 seconds and have no inode or real change time, so an equal mtime alone cannot prove a file is unchanged.
    #[serde(default)]
    pub hash: String,
}

/// A cheap, stable, non-cryptographic hash of a file's bytes (never used for security).
fn content_hash(p: &Path, len: u64) -> String {
    if len > MAX_READ_BYTES {
        return String::new();
    }
    match fs::read(p) {
        Ok(b) => {
            let mut h: u64 = 0xcbf29ce484222325;
            for x in b {
                h ^= x as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            format!("{h:016x}")
        }
        Err(_) => String::new(),
    }
}

/// The full stamp of the file at `p` (following a link): metadata plus the content hash.
fn stamp_at(p: &Path) -> std::io::Result<Stamp> {
    let m = fs::metadata(p)?;
    let mut s = stamp_of(&m);
    if m.is_file() {
        s.hash = content_hash(p, m.len());
    }
    Ok(s)
}

/// Whole microseconds since the epoch (negative before it).
fn us(t: std::io::Result<std::time::SystemTime>) -> i64 {
    match t {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_micros() as i64,
            Err(e) => -(e.duration().as_micros() as i64),
        },
        Err(_) => 0,
    }
}

pub fn stamp_of(m: &fs::Metadata) -> Stamp {
    let mtime_us = us(m.modified());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Stamp {
            size: m.len(),
            mtime_us,
            ctime_us: m.ctime() * 1_000_000 + m.ctime_nsec() / 1000,
            ino: m.ino().to_string(),
            hash: String::new(),
        }
    }
    #[cfg(not(unix))]
    {
        // Windows: the creation time changes when a file is replaced; the file index is not available on stable std
        Stamp {
            size: m.len(),
            mtime_us,
            ctime_us: us(m.created()),
            ino: String::new(),
            hash: String::new(),
        }
    }
}

/// Makes temp file names unique within the process even when two threads read the same clock tick (the nanosecond clock is coarse on
/// some systems); the stray-temp cleaner accepts the extra digits.
fn unique_suffix() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    )
}

pub const CONFLICT: &str = "CONFLICT: the file changed while it was being written";
pub const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;

/// `^entries(\.backup|\.backup-daily|\.broken-[0-9a-z-]{1,40})?\.json$`, written out by hand (no regex crate needed).
pub fn valid_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("entries") else {
        return false;
    };
    let Some(mid) = rest.strip_suffix(".json") else {
        return false;
    };
    if mid.is_empty() || mid == ".backup" || mid == ".backup-daily" {
        return true;
    }
    match mid.strip_prefix(".broken-") {
        Some(tail) => {
            !tail.is_empty()
                && tail.len() <= 40
                && tail
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b == b'-')
        }
        None => false,
    }
}

/// The path of a data file, or an error. Never returns a path outside `dir`.
pub fn resolve(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("not an allowed file name: {name:?}"));
    }
    // canonicalise the folder when it exists (it may be a symlink the user made); a missing folder is created on write
    let base = match dir.canonicalize() {
        Ok(c) => c,
        Err(_) => dir.to_path_buf(),
    };
    let p = base.join(name);
    if p.parent() != Some(base.as_path()) {
        return Err("path escapes the data folder".into());
    }
    Ok(p)
}

/// Only entries.json may be a link the app follows (and only after `validate_link`). Backups and `.broken-` names are
/// never written through a link: a link with such a name is replaced by the new file (the target is not touched).
fn may_follow(name: &str) -> bool {
    name == "entries.json"
}

const MAX_APP_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// What the app is willing to overwrite behind a link: an empty file, or a JSON object that looks like entries.json
/// (a number `version`, an `entries` array, a `settings` object, at least one of them, and no wrong type among them).
/// The strict field-by-field decoder lives in the page; this is the part of it the Rust side can check, enough that
/// ~/.zshrc, authorized_keys, package.json and any other non-app file are refused.
pub fn is_app_json(text: &str) -> bool {
    let t = text.trim_start_matches('\u{FEFF}').trim();
    if t.is_empty() {
        return true;
    }
    let Ok(serde_json::Value::Object(o)) = serde_json::from_str::<serde_json::Value>(t) else {
        return false;
    };
    let mut known = false;
    if let Some(v) = o.get("entries") {
        if !v.is_array() {
            return false;
        }
        known = true;
    }
    if let Some(v) = o.get("settings") {
        if !v.is_object() {
            return false;
        }
        known = true;
    }
    if let Some(v) = o.get("version") {
        if !v.is_number() {
            return false;
        }
        known = true;
    }
    known
}

/// Device and inode of a file (zeros where the OS has neither: Windows compares canonical paths only).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Ident {
    dev: u64,
    ino: u64,
}

fn ident(m: &fs::Metadata) -> Ident {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ident {
            dev: m.dev(),
            ino: m.ino(),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = m;
        Ident { dev: 0, ino: 0 }
    }
}

fn owned_by_me(m: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no arguments and cannot fail.
        m.uid() == unsafe { libc::geteuid() }
    }
    #[cfg(not(unix))]
    {
        let _ = m;
        true
    }
}

/// Opens without following a link in the last component and without blocking on a fifo.
fn open_nofollow(p: &Path) -> std::io::Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    o.open(p)
}

struct Followed {
    target: PathBuf,
    id: Ident,
    meta: fs::Metadata,
}

fn link_refusal(name: &str, why: &str) -> String {
    format!("{name} is a link and {why}, so nothing was written. Remove the link, or point it at a Money Bar file you own.")
}

/// Rule for a symlinked entries.json: follow it only when it points at an existing regular file that this user owns and
/// whose content is empty or a Money Bar file. Everything else is refused with a named error.
fn validate_link(p: &Path, name: &str) -> Result<Followed, String> {
    let target = p
        .canonicalize()
        .map_err(|_| link_refusal(name, "it points at nothing"))?;
    // stat before open: a fifo or device is never opened
    let m = fs::metadata(&target).map_err(|_| link_refusal(name, "its target cannot be read"))?;
    if !m.is_file() {
        return Err(link_refusal(name, "its target is not a regular file"));
    }
    if !owned_by_me(&m) {
        return Err(link_refusal(name, "its target belongs to another user"));
    }
    if m.len() > MAX_APP_FILE_BYTES {
        return Err(link_refusal(
            name,
            "its target is too large to be a Money Bar file",
        ));
    }
    let mut f = open_nofollow(&target)
        .map_err(|_| link_refusal(name, "its target cannot be opened safely"))?;
    let fm = f
        .metadata()
        .map_err(|_| link_refusal(name, "its target cannot be read"))?;
    if !fm.is_file() || ident(&fm) != ident(&m) {
        return Err(link_refusal(
            name,
            "its target changed while it was checked",
        ));
    }
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut f, &mut bytes)
        .map_err(|_| link_refusal(name, "its target cannot be read"))?;
    match String::from_utf8(bytes) {
        Ok(t) if is_app_json(&t) => Ok(Followed {
            target,
            id: ident(&fm),
            meta: fm,
        }),
        _ => Err(link_refusal(name, "its target is not a Money Bar file")),
    }
}

/// Last check before the rename (the target must still be the very file that was validated).
fn recheck_link(p: &Path, name: &str, f: &Followed) -> Result<(), String> {
    let changed = || link_refusal(name, "it changed while it was being written");
    let lm = fs::symlink_metadata(p).map_err(|_| changed())?;
    if !lm.file_type().is_symlink() || p.canonicalize().map_err(|_| changed())? != f.target {
        return Err(changed());
    }
    let tm = fs::symlink_metadata(&f.target).map_err(|_| changed())?;
    // device+inode, and also size, modification time and change time as they were when the target was validated: a file replaced by
    // one that reuses the freed inode number (common on ext4 and tmpfs) still differs in these. Inside one call nothing legitimate
    // touches the target between validation and rename; a concurrent legitimate writer is a compare-and-swap conflict anyway.
    if tm.file_type().is_symlink()
        || !tm.is_file()
        || ident(&tm) != f.id
        || !owned_by_me(&tm)
        || stamp_of(&tm) != stamp_of(&f.meta)
    {
        return Err(changed());
    }
    Ok(())
}

pub fn read(dir: &Path, name: &str) -> Result<Option<String>, String> {
    let p = resolve(dir, name)?;
    if let Ok(lm) = fs::symlink_metadata(&p) {
        if lm.file_type().is_symlink() {
            // a link is read only when it points at a regular file this user owns (its content is checked by the page)
            match fs::metadata(&p) {
                Ok(m) if m.is_file() && owned_by_me(&m) && m.len() <= MAX_APP_FILE_BYTES => {}
                Ok(_) => {
                    return Err(link_refusal(
                        name,
                        "its target is not a regular file you own",
                    ))
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(format!("cannot read {name}: {e}")),
            }
        }
    }
    // stat first: a fifo or device named entries.json must never be opened (it could block forever), and a huge file is refused
    match fs::metadata(&p) {
        Ok(m) if !m.is_file() => {
            return Err(format!("{name} is not a regular file, so it was not read"))
        }
        Ok(m) if m.len() > MAX_READ_BYTES => {
            return Err(format!(
                "{name} is larger than {} MB, so it was not read",
                MAX_READ_BYTES / 1024 / 1024
            ))
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read {name}: {e}")),
    }
    match fs::read(&p) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| format!("{name} is not valid UTF-8 text (UTF-16 or another encoding): save it again as UTF-8")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {name}: {e}")),
    }
}

pub fn stat(dir: &Path, name: &str) -> Result<Option<Stamp>, String> {
    let p = resolve(dir, name)?;
    match stamp_at(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot stat {name}: {e}")),
    }
}

/// An exclusive lock on `<data folder>/.lock`, held while a compare-and-swap write checks the stamp and renames. Another
/// process holding it (a second copy of this app) is waited for, up to about 3 seconds.
struct Lock {
    _f: fs::File,
}
impl Lock {
    fn acquire(dir: &Path) -> Result<Lock, String> {
        let f = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(".lock"))
            .map_err(|e| format!("cannot open the lock file: {e}"))?;
        for _ in 0..150 {
            if f.try_lock().is_ok() {
                return Ok(Lock { _f: f });
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Err("another copy is writing the data folder right now; try again".into())
    }
}

/// Retries a rename that fails for a moment on Windows (an antivirus scanner or the search indexer holds the file open:
/// access denied or sharing violation). Other systems rename once.
const RETRY_DELAYS_MS: [u64; 5] = [20, 50, 100, 200, 400];
fn is_transient(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33))
}
fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for d in std::iter::once(0).chain(RETRY_DELAYS_MS) {
        if d > 0 {
            std::thread::sleep(std::time::Duration::from_millis(d));
        }
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if cfg!(windows) && is_transient(&e) => last = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

pub fn write(
    dir: &Path,
    name: &str,
    text: &str,
    check: Option<Option<Stamp>>,
) -> Result<(), String> {
    write_with_hook(dir, name, text, check, &mut || {})
}

/// `write`, with a hook that runs after the content is on disk and before the final check and rename: tests use it to swap
/// a link at the worst moment.
///
/// * A plain file (or a hard-linked one) is replaced by renaming a temp file in the data folder over it: the old inode,
///   and any other name for it, is left as it was.
/// * A symlinked entries.json is followed only after `validate_link`; the temp file goes in the data folder when the target
///   is on the same filesystem, otherwise next to the (validated) target; `recheck_link` runs right before the rename.
/// * A link under any other name (the backups) is replaced by a regular file; its target is never touched.
// on Windows the block below clears only the read-only attribute, of this call's own temp file (clippy flags every set_readonly(false))
#[allow(clippy::permissions_set_readonly_false)]
pub fn write_with_hook(
    dir: &Path,
    name: &str,
    text: &str,
    check: Option<Option<Stamp>>,
    hook: &mut dyn FnMut(),
) -> Result<(), String> {
    resolve(dir, name)?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create the data folder: {e}"))?;
    let p = resolve(dir, name)?;
    let base = p.parent().ok_or("no folder for the file")?.to_path_buf();
    let link = fs::symlink_metadata(&p).ok();
    if link.as_ref().is_some_and(|m| m.is_dir()) {
        return Err(format!("{name} is a folder, not a file"));
    }
    // a read-only file is refused (the owner marked it as not to be changed)
    if link
        .as_ref()
        .is_some_and(|m| !m.file_type().is_symlink() && m.permissions().readonly())
    {
        return Err(format!("{name} is read-only, so nothing was written"));
    }
    let followed = match &link {
        Some(m) if m.file_type().is_symlink() && may_follow(name) => Some(validate_link(&p, name)?),
        _ => None,
    };
    let (dest, tmp_dir): (PathBuf, PathBuf) = match &followed {
        Some(f) => {
            let tparent = f
                .target
                .parent()
                .ok_or("no folder for the linked file")?
                .to_path_buf();
            let same_fs = fs::metadata(&base)
                .map(|m| ident(&m).dev == f.id.dev)
                .unwrap_or(false)
                && f.id.dev != 0;
            (
                f.target.clone(),
                if same_fs { base.clone() } else { tparent },
            )
        }
        None => (p.clone(), base.clone()),
    };
    let tmp = tmp_dir.join(format!(".{name}.tmp-{}", unique_suffix()));
    let result = (|| -> Result<(), String> {
        let io = |e: std::io::Error| format!("could not write {name}: {e}");
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(io)?;
        f.write_all(text.as_bytes()).map_err(io)?;
        f.sync_all().map_err(io)?;
        drop(f);
        let perms = match &followed {
            Some(f) => Some(f.meta.permissions()),
            None => fs::metadata(&dest)
                .ok()
                .filter(|m| m.is_file())
                .map(|m| m.permissions()),
        };
        if let Some(pm) = perms {
            let _ = fs::set_permissions(&tmp, pm);
        }
        // Windows: never carry a read-only attribute onto the temp file (the rename over the target would be refused); only the TEMP file
        // is touched, a read-only target was already refused above
        #[cfg(windows)]
        {
            if let Ok(m) = fs::metadata(&tmp) {
                let mut pm = m.permissions();
                if pm.readonly() {
                    pm.set_readonly(false);
                    let _ = fs::set_permissions(&tmp, pm);
                }
            }
        }
        hook();
        // the lock covers the check and the rename together (created only after the path was validated)
        let _lock = if check.is_some() {
            Some(Lock::acquire(&base)?)
        } else {
            None
        };
        if let Some(expected) = &check {
            let now = stamp_at(&p).ok();
            if now != *expected {
                return Err(CONFLICT.into());
            }
        }
        if let Some(f) = &followed {
            recheck_link(&p, name, f)?;
        }
        rename_retry(&tmp, &dest).map_err(io)?;
        #[cfg(unix)]
        {
            if let Ok(d) = fs::File::open(dest.parent().unwrap_or(&base)) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Keeps an unreadable file as a backup under a NEW unique name (`entries.broken-<millis>-<nanos hex><n>.json`, derived from the
/// time and process, never a name that exists) and returns that name. A link under the file's name is moved itself, its target
/// untouched. `requested` only has to be a `.broken-` name; the unique one is used instead, so there is no "exists" race.
pub fn move_aside(dir: &Path, name: &str, requested: &str) -> Result<String, String> {
    let from = resolve(dir, name)?;
    resolve(dir, requested)?;
    if !requested.contains(".broken-") {
        return Err("a backup name must contain .broken-".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    for n in 0..1000u32 {
        let unique = format!(
            "entries.broken-{}-{:x}{}.json",
            now.as_millis(),
            now.subsec_nanos() ^ std::process::id(),
            n
        );
        let to = resolve(dir, &unique)?;
        // symlink_metadata: a link under that name (even a dangling one) counts as taken and is never replaced
        if fs::symlink_metadata(&to).is_ok() {
            continue;
        }
        fs::rename(&from, &to).map_err(|e| format!("could not keep a backup of {name}: {e}"))?;
        return Ok(unique);
    }
    Err("could not find a free backup name".into())
}

/// Deletes leftovers of interrupted atomic writes (".entries.json.tmp-<pid>-<nanos>") older than `older_than_secs`
/// (0 = all). Only files of exactly that shape are touched. Returns how many were removed.
pub fn remove_stray_temps(dir: &Path, older_than_secs: u64) -> usize {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix('.') else {
            continue;
        };
        let Some((base, tail)) = rest.split_once(".tmp-") else {
            continue;
        };
        if !valid_name(base)
            || tail.is_empty()
            || !tail.bytes().all(|b| b.is_ascii_digit() || b == b'-')
        {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if older_than_secs > 0 {
            let age = meta
                .modified()
                .ok()
                .and_then(|m| m.elapsed().ok())
                .map(|d| d.as_secs())
                .unwrap_or(u64::MAX);
            if age < older_than_secs {
                continue;
            }
        }
        if fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;

/// Checks a path chosen in the save dialog before the CSV is written there: absolute, a `.csv` name, an existing folder
/// that is not the data folder, and no symlink or folder at the target. The webview cannot be trusted to send only what
/// the dialog returned, so this is checked again here.
pub fn validate_export_path(path: &str, data_dir: &Path) -> Result<PathBuf, String> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\0')
        || path.chars().any(|c| c.is_control())
    {
        return Err("not a usable file path".into());
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("the file path must be absolute".into());
    }
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("the path has no file name")?;
    if !name.to_ascii_lowercase().ends_with(".csv") || name.len() <= 4 {
        return Err("the file must have a .csv name".into());
    }
    let parent = p.parent().ok_or("the path has no folder")?;
    let parent = parent
        .canonicalize()
        .map_err(|_| "the folder does not exist".to_string())?;
    if !parent.is_dir() {
        return Err("the folder does not exist".into());
    }
    if let Ok(d) = data_dir.canonicalize() {
        if parent == d {
            return Err("export to a folder outside the Money Bar data folder".into());
        }
    }
    let target = parent.join(name);
    match fs::symlink_metadata(&target) {
        Ok(m) if m.file_type().is_symlink() => {
            return Err("the target is a link; pick a normal file".into())
        }
        Ok(m) if !m.is_file() => return Err("the target is not a regular file".into()),
        _ => {}
    }
    Ok(target)
}

/// Leftovers of an interrupted export (".moneybar-export.tmp-<pid>-<nanos>") older than `older_than_secs` in one folder.
pub fn remove_export_temps(dir: &Path, older_than_secs: u64) -> usize {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(tail) = name.strip_prefix(".moneybar-export.tmp-") else {
            continue;
        };
        if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
            continue;
        }
        let Ok(m) = e.metadata() else { continue };
        if !m.is_file() {
            continue;
        }
        let age = m
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map(|d| d.as_secs())
            .unwrap_or(u64::MAX);
        if age >= older_than_secs && fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Writes the CSV with a UTF-8 byte order mark in front (so Excel reads Persian and accented text) to a validated path,
/// atomically: the temp file is made in the data folder when that is on the same filesystem as the target, otherwise beside
/// the target; a read-only target is refused.
pub fn export_csv(path: &str, text: &str, data_dir: &Path) -> Result<(), String> {
    if text.len() > MAX_EXPORT_BYTES {
        return Err("the export is too large".into());
    }
    let target = validate_export_path(path, data_dir)?;
    let parent = target.parent().ok_or("no folder")?.to_path_buf();
    if fs::metadata(&target).is_ok_and(|m| m.permissions().readonly()) {
        return Err("that file is read-only, so it was not replaced".into());
    }
    let same_fs = match (fs::metadata(&parent), fs::metadata(data_dir)) {
        (Ok(a), Ok(b)) => ident(&a).dev == ident(&b).dev && ident(&a).dev != 0,
        _ => false,
    };
    let tmp_dir = if same_fs && data_dir.is_dir() {
        data_dir.to_path_buf()
    } else {
        parent.clone()
    };
    let tmp = tmp_dir.join(format!(".moneybar-export.tmp-{}", unique_suffix()));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        if !text.starts_with('\u{FEFF}') {
            f.write_all(&[0xEF, 0xBB, 0xBF])?;
        }
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        // the same Windows retry as entries.json: a virus scanner opening the fresh temp file must not fail the export
        rename_retry(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("could not write the file: {e}"))
}

/// A suggested file name for the save dialog: plain characters only, ending in .csv.
pub fn suggested_csv_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
        .take(100)
        .collect();
    let stem = cleaned
        .trim_matches(|c| c == '.' || c == ' ')
        .trim_end_matches(".csv")
        .trim_end_matches(".CSV")
        .trim_matches('.')
        .to_string();
    if stem.is_empty() {
        "money-bar-report.csv".into()
    } else {
        format!("{stem}.csv")
    }
}

/// The whole export: the page supplies only the text and a suggested name. `pick` stands for the native save dialog (injected,
/// so tests need no window): it receives the suggested name and returns the path the user chose, or None when cancelled.
/// Nothing is written to any other path. Stale export temp files in the chosen folder (older than an hour) are removed, and the
/// folder is remembered in `last_dir` (the next export's leftovers are cleaned there too).
pub fn run_export(
    pick: impl FnOnce(&str) -> Option<PathBuf>,
    suggested: &str,
    text: &str,
    data_dir: &Path,
    last_dir: &std::sync::Mutex<Option<PathBuf>>,
) -> Result<Option<String>, String> {
    if let Some(prev) = last_dir.lock().map_err(|_| "internal error")?.clone() {
        remove_export_temps(&prev, 3600);
    }
    let Some(path) = pick(&suggested_csv_name(suggested)) else {
        return Ok(None);
    };
    let path_str = path
        .to_str()
        .ok_or("the chosen path is not valid text")?
        .to_string();
    export_csv(&path_str, text, data_dir)?;
    if let Some(parent) = path.parent().and_then(|p| p.canonicalize().ok()) {
        remove_export_temps(&parent, 3600);
        *last_dir.lock().map_err(|_| "internal error")? = Some(parent);
    }
    Ok(Some(path_str))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_checked() {
        for ok in [
            "entries.json",
            "entries.backup.json",
            "entries.backup-daily.json",
            "entries.broken-1760000000000-ab12cd.json",
            "entries.broken-1.json",
        ] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "",
            "../entries.json",
            "entries.json/",
            "a/entries.json",
            "..",
            ".",
            "entries.json.bak",
            "other.json",
            "entries.broken-.json",
            "entries.json\n",
            "C:\\x.json",
            "entries\0.json",
            "entries.broken-UPPER.json",
            "entries.broken-../x.json",
            "/etc/passwd",
            "entries.json ",
            "Entries.json",
            "tasks.json",
            "entries.backup.backup.json",
            "entries.backup-.json",
            "entries..json",
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
        assert!(!valid_name(&format!(
            "entries.broken-{}.json",
            "a".repeat(41)
        )));
    }

    #[test]
    fn traversal_is_refused_and_nothing_is_created() {
        let d = tempfile::tempdir().unwrap();
        let outside = d.path().join("outside.json");
        let data = d.path().join("data");
        for bad in [
            "../outside.json",
            "..\\outside.json",
            "entries.json/../../outside.json",
            "/tmp/x.json",
        ] {
            assert!(write(&data, bad, "x", None).is_err(), "{bad}");
            assert!(read(&data, bad).is_err(), "{bad}");
            assert!(stat(&data, bad).is_err(), "{bad}");
        }
        assert!(!outside.exists());
        assert!(
            !data.exists(),
            "a refused write must not even create the folder"
        );
    }

    #[test]
    fn write_read_stat_round_trip_and_no_temp_left() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("MoneyBar");
        assert_eq!(read(&data, "entries.json").unwrap(), None);
        assert_eq!(stat(&data, "entries.json").unwrap(), None);
        write(&data, "entries.json", "{\"entries\":[]}\n", None).unwrap();
        assert_eq!(
            read(&data, "entries.json").unwrap().as_deref(),
            Some("{\"entries\":[]}\n")
        );
        assert_eq!(stat(&data, "entries.json").unwrap().unwrap().size, 15);
        write(&data, "entries.json", "{\"entries\":[1]}\n", None).unwrap();
        assert_eq!(stat(&data, "entries.json").unwrap().unwrap().size, 16);
        let names: Vec<_> = fs::read_dir(&data)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            names,
            vec!["entries.json".to_string()],
            "no temp files left"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_file_stays_a_link() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let real = d.path().join("real.json");
        fs::write(&real, "{\"entries\":[]}").unwrap();
        std::os::unix::fs::symlink(&real, data.join("entries.json")).unwrap();
        write(&data, "entries.json", "{\"entries\":[1]}", None).unwrap();
        assert!(fs::symlink_metadata(data.join("entries.json"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "{\"entries\":[1]}");
    }

    #[test]
    fn move_aside_keeps_a_backup_under_a_new_unique_name_and_never_overwrites_one() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "entries.json", "broken", None).unwrap();
        let first = move_aside(d.path(), "entries.json", "entries.broken-1-abc.json").unwrap();
        assert!(valid_name(&first) && first.contains(".broken-"), "{first}");
        assert!(!d.path().join("entries.json").exists());
        assert_eq!(fs::read_to_string(d.path().join(&first)).unwrap(), "broken");
        write(d.path(), "entries.json", "second", None).unwrap();
        let second = move_aside(d.path(), "entries.json", "entries.broken-1-abc.json").unwrap();
        assert_ne!(
            first, second,
            "the same requested name never reuses a taken one"
        );
        assert_eq!(fs::read_to_string(d.path().join(&first)).unwrap(), "broken");
        assert_eq!(
            fs::read_to_string(d.path().join(&second)).unwrap(),
            "second"
        );
        write(d.path(), "entries.json", "third", None).unwrap();
        assert!(
            move_aside(d.path(), "entries.json", "entries.backup.json").is_err(),
            "a backup name must contain .broken-"
        );
        assert_eq!(
            fs::read_to_string(d.path().join("entries.json")).unwrap(),
            "third"
        );
        // many in a row are all distinct
        let mut seen = std::collections::HashSet::new();
        for i in 0..50 {
            write(d.path(), "entries.json", &i.to_string(), None).unwrap();
            assert!(
                seen.insert(move_aside(d.path(), "entries.json", "entries.broken-x.json").unwrap())
            );
        }
    }

    #[test]
    fn a_stat_changes_when_the_content_changes_even_within_one_second() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "entries.json", "aaa", None).unwrap();
        let a = stat(d.path(), "entries.json").unwrap().unwrap();
        write(d.path(), "entries.json", "aaaa", None).unwrap();
        assert_ne!(a, stat(d.path(), "entries.json").unwrap().unwrap());
    }

    #[test]
    fn invalid_utf8_is_an_error_not_a_panic() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("entries.json"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(read(d.path(), "entries.json").is_err());
    }

    #[test]
    fn stray_temps_go_only_when_old_enough_and_of_the_right_shape() {
        let d = tempfile::tempdir().unwrap();
        for n in [
            ".entries.json.tmp-1-2",
            ".entries.backup.json.tmp-3-4",
            "entries.json",
            "notes.txt",
            ".entries.json.tmp-x",
            ".other.json.tmp-1-2",
            ".entries.json.tmp-",
        ] {
            fs::write(d.path().join(n), "x").unwrap();
        }
        assert_eq!(
            remove_stray_temps(d.path(), 3600),
            0,
            "fresh temps are kept"
        );
        assert_eq!(remove_stray_temps(d.path(), 0), 2);
        assert!(d.path().join("entries.json").exists() && d.path().join("notes.txt").exists());
        assert!(
            d.path().join(".entries.json.tmp-x").exists()
                && d.path().join(".other.json.tmp-1-2").exists()
        );
        assert_eq!(remove_stray_temps(&d.path().join("missing"), 0), 0);
    }

    #[test]
    fn export_paths_are_validated() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let out = d.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let good = out.join("report.csv");
        assert!(validate_export_path(good.to_str().unwrap(), &data).is_ok());
        assert!(validate_export_path(out.join("REPORT.CSV").to_str().unwrap(), &data).is_ok());
        for bad in ["", "report.csv", "relative/report.csv", "/tmp/../tmp/x.txt"] {
            assert!(validate_export_path(bad, &data).is_err(), "{bad:?}");
        }
        assert!(validate_export_path(out.join("report.txt").to_str().unwrap(), &data).is_err());
        assert!(validate_export_path(out.join(".csv").to_str().unwrap(), &data).is_err());
        assert!(
            validate_export_path(out.join("missing").join("a.csv").to_str().unwrap(), &data)
                .is_err()
        );
        assert!(
            validate_export_path(data.join("a.csv").to_str().unwrap(), &data).is_err(),
            "never into the data folder"
        );
        assert!(validate_export_path("/tmp/a\nb.csv", &data).is_err());
        assert!(validate_export_path(
            &format!("{}/{}.csv", out.display(), "a".repeat(5000)),
            &data
        )
        .is_err());
        fs::create_dir(out.join("dir.csv")).unwrap();
        assert!(
            validate_export_path(out.join("dir.csv").to_str().unwrap(), &data).is_err(),
            "a folder is not a file"
        );
        #[cfg(unix)]
        {
            let victim = d.path().join("victim.txt");
            fs::write(&victim, "keep").unwrap();
            std::os::unix::fs::symlink(&victim, out.join("link.csv")).unwrap();
            assert!(
                validate_export_path(out.join("link.csv").to_str().unwrap(), &data).is_err(),
                "a symlink is never followed"
            );
            assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
        }
    }

    #[test]
    fn export_writes_a_bom_once_atomically() {
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        let out = d.path().join("out");
        fs::create_dir_all(&out).unwrap();
        let p = out.join("r.csv");
        export_csv(
            p.to_str().unwrap(),
            "Money Bar report\r\nنمونه,1.00\r\n",
            &data,
        )
        .unwrap();
        let bytes = fs::read(&p).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(&bytes[3..6], b"Mon");
        export_csv(p.to_str().unwrap(), "\u{FEFF}again", &data).unwrap();
        assert_eq!(
            fs::read(&p).unwrap(),
            [&[0xEF, 0xBB, 0xBF][..], b"again"].concat(),
            "a BOM already there is not doubled"
        );
        let names: Vec<_> = fs::read_dir(&out)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["r.csv".to_string()], "no temp left");
        assert!(export_csv(out.join("x.txt").to_str().unwrap(), "x", &data).is_err());
        assert!(!out.join("x.txt").exists());
    }

    // ---- symlink rules (Unix): a link is followed only to a valid Money Bar file this user owns

    #[cfg(unix)]
    mod links {
        use super::*;
        use std::os::unix::fs::symlink;

        struct Rig {
            _d: tempfile::TempDir,
            data: PathBuf,
            other: PathBuf,
        }
        fn rig() -> Rig {
            let d = tempfile::tempdir().unwrap();
            let data = d.path().join("data");
            let other = d.path().join("other");
            fs::create_dir_all(&data).unwrap();
            fs::create_dir_all(&other).unwrap();
            Rig { _d: d, data, other }
        }
        fn names(dir: &Path) -> Vec<String> {
            let mut v: Vec<String> = fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
                .collect();
            v.sort();
            v
        }

        #[test]
        fn a_link_to_a_non_app_file_is_refused_and_the_victim_is_untouched() {
            let r = rig();
            for (i, content) in [
                "export PATH=/x\nalias ls='rm -rf ~'\n",
                "ssh-ed25519 AAAA key",
                "{\"name\":\"package\",\"version\":\"1.0\"}",
                "[]",
                "{}",
                "{\"entries\":5}",
                "{\"settings\":[]}",
                "\u{0}\u{1}",
            ]
            .iter()
            .enumerate()
            {
                let victim = r.other.join(format!("victim{i}"));
                fs::write(&victim, content).unwrap();
                let link = r.data.join("entries.json");
                let _ = fs::remove_file(&link);
                symlink(&victim, &link).unwrap();
                let e = write(&r.data, "entries.json", "{\"entries\":[]}", None).unwrap_err();
                assert!(e.contains("not a Money Bar file"), "{e}");
                assert_eq!(fs::read_to_string(&victim).unwrap(), *content);
                assert_eq!(
                    names(&r.data),
                    vec!["entries.json".to_string()],
                    "no temp file in the data folder"
                );
                assert!(
                    !names(&r.other).iter().any(|n| n.starts_with('.')),
                    "no temp file in the other folder: {:?}",
                    names(&r.other)
                );
            }
        }

        #[test]
        fn a_link_to_a_valid_or_empty_app_file_is_followed_and_stays_a_link() {
            let r = rig();
            for start in [
                "{\"version\":1,\"settings\":{},\"entries\":[]}",
                "",
                "\u{FEFF}{\"entries\":[]}\n",
            ] {
                let real = r.other.join("real.json");
                fs::write(&real, start).unwrap();
                let link = r.data.join("entries.json");
                let _ = fs::remove_file(&link);
                symlink(&real, &link).unwrap();
                write(&r.data, "entries.json", "{\"entries\":[7]}", None).unwrap();
                assert!(fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink());
                assert_eq!(fs::read_to_string(&real).unwrap(), "{\"entries\":[7]}");
                assert_eq!(
                    read(&r.data, "entries.json").unwrap().as_deref(),
                    Some("{\"entries\":[7]}")
                );
            }
            assert!(
                !names(&r.other).iter().any(|n| n.starts_with('.')),
                "no temp file left in the other folder"
            );
        }

        #[test]
        fn the_temp_file_of_a_followed_link_is_made_in_the_data_folder() {
            let r = rig();
            let real = r.other.join("real.json");
            fs::write(&real, "{\"entries\":[]}").unwrap();
            symlink(&real, r.data.join("entries.json")).unwrap();
            let (data, other) = (r.data.clone(), r.other.clone());
            let mut seen = (0, 0);
            write_with_hook(
                &r.data,
                "entries.json",
                "{\"entries\":[2]}",
                None,
                &mut || {
                    seen = (
                        names(&data).iter().filter(|n| n.contains(".tmp-")).count(),
                        names(&other).iter().filter(|n| n.contains(".tmp-")).count(),
                    );
                },
            )
            .unwrap();
            assert_eq!(
                seen,
                (1, 0),
                "same filesystem: the temp file is in the data folder only"
            );
        }

        #[test]
        fn a_link_to_a_folder_a_dangling_link_and_a_fifo_are_refused() {
            let r = rig();
            let link = r.data.join("entries.json");
            symlink(&r.other, &link).unwrap();
            assert!(write(&r.data, "entries.json", "{\"entries\":[]}", None)
                .unwrap_err()
                .contains("not a regular file"));
            assert!(read(&r.data, "entries.json").is_err());
            fs::remove_file(&link).unwrap();
            let missing = r.other.join("later.json");
            symlink(&missing, &link).unwrap();
            assert!(write(&r.data, "entries.json", "{\"entries\":[]}", None)
                .unwrap_err()
                .contains("points at nothing"));
            assert!(!missing.exists(), "a dangling link is not written through");
            assert_eq!(read(&r.data, "entries.json").unwrap(), None);
            fs::remove_file(&link).unwrap();
            let fifo = r.other.join("pipe");
            let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
            // SAFETY: a valid NUL-terminated path and a plain mode.
            if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } == 0 {
                symlink(&fifo, &link).unwrap();
                assert!(write(&r.data, "entries.json", "{\"entries\":[]}", None)
                    .unwrap_err()
                    .contains("not a regular file"));
                assert!(
                    read(&r.data, "entries.json").is_err(),
                    "a fifo is never opened"
                );
            }
            assert_eq!(names(&r.data), vec!["entries.json".to_string()]);
        }

        #[test]
        fn a_link_swapped_between_the_check_and_the_rename_is_refused() {
            // the link is swapped to point at a victim
            let r = rig();
            let real = r.other.join("real.json");
            let victim = r.other.join("victim");
            fs::write(&real, "{\"entries\":[]}").unwrap();
            fs::write(&victim, "secret").unwrap();
            let link = r.data.join("entries.json");
            symlink(&real, &link).unwrap();
            let l2 = link.clone();
            let v2 = victim.clone();
            let e = write_with_hook(
                &r.data,
                "entries.json",
                "{\"entries\":[1]}",
                None,
                &mut || {
                    fs::remove_file(&l2).unwrap();
                    symlink(&v2, &l2).unwrap();
                },
            )
            .unwrap_err();
            assert!(e.contains("changed while it was being written"), "{e}");
            assert_eq!(fs::read_to_string(&victim).unwrap(), "secret");
            assert_eq!(fs::read_to_string(&real).unwrap(), "{\"entries\":[]}");
            assert_eq!(
                names(&r.data),
                vec!["entries.json".to_string()],
                "the temp file is removed"
            );

            // the target file is replaced by another file (a different inode) at the same path. The replacement is made FIRST, under
            // another name, while the old file is still alive: deleting and recreating can hand the freed inode number straight back
            // (ext4 and tmpfs do), which would make the swap invisible by device and inode and the test pass or fail by luck.
            use std::os::unix::fs::MetadataExt;
            fs::remove_file(&link).unwrap();
            symlink(&real, &link).unwrap();
            let replacement = r.other.join("replacement.json");
            fs::write(&replacement, "{\"entries\":[\"someone else\"]}").unwrap();
            let (old_ino, new_ino) = (
                fs::metadata(&real).unwrap().ino(),
                fs::metadata(&replacement).unwrap().ino(),
            );
            assert_ne!(
                old_ino, new_ino,
                "two live files never share an inode number: the swap below is a real one"
            );
            let (real2, repl2) = (real.clone(), replacement.clone());
            let e = write_with_hook(
                &r.data,
                "entries.json",
                "{\"entries\":[1]}",
                None,
                &mut || {
                    fs::rename(&repl2, &real2).unwrap();
                },
            )
            .unwrap_err();
            assert!(e.contains("changed while it was being written"), "{e}");
            assert_eq!(
                fs::metadata(&real).unwrap().ino(),
                new_ino,
                "the replacement really is what is at the path now"
            );
            assert_eq!(
                fs::read_to_string(&real).unwrap(),
                "{\"entries\":[\"someone else\"]}"
            );
            assert_eq!(names(&r.data), vec!["entries.json".to_string()]);

            // the target is changed in place (same inode, as when an inode number is reused): size, modification and change time catch it
            fs::write(&real, "{\"entries\":[]}").unwrap();
            let real3 = real.clone();
            let ino_before = fs::metadata(&real).unwrap().ino();
            let e = write_with_hook(
                &r.data,
                "entries.json",
                "{\"entries\":[1]}",
                None,
                &mut || {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    fs::write(&real3, "{\"entries\":[2,3]}").unwrap();
                },
            )
            .unwrap_err();
            assert_eq!(
                fs::metadata(&real).unwrap().ino(),
                ino_before,
                "same inode: only the stamp can tell"
            );
            assert!(e.contains("changed while it was being written"), "{e}");
            assert_eq!(fs::read_to_string(&real).unwrap(), "{\"entries\":[2,3]}");
            assert_eq!(names(&r.data), vec!["entries.json".to_string()]);
        }

        #[test]
        fn backups_and_move_aside_are_never_written_through_a_link() {
            let r = rig();
            for name in ["entries.backup.json", "entries.backup-daily.json"] {
                let victim = r.other.join(format!("victim-{name}"));
                fs::write(&victim, "{\"entries\":[\"mine\"]}").unwrap(); // even a valid app file behind a backup name is never touched
                symlink(&victim, r.data.join(name)).unwrap();
                write(&r.data, name, "{\"entries\":[\"backup\"]}", None).unwrap();
                assert_eq!(
                    fs::read(&victim).unwrap(),
                    b"{\"entries\":[\"mine\"]}",
                    "victim byte-identical"
                );
                assert!(
                    !fs::symlink_metadata(r.data.join(name))
                        .unwrap()
                        .file_type()
                        .is_symlink(),
                    "the link itself was replaced"
                );
                assert_eq!(
                    fs::read_to_string(r.data.join(name)).unwrap(),
                    "{\"entries\":[\"backup\"]}"
                );
            }
            // a dangling backup link: the link is replaced, nothing is created at its target
            let missing = r.other.join("nothing-here");
            symlink(&missing, r.data.join("entries.broken-1-a.json")).unwrap();
            write(&r.data, "entries.broken-1-a.json", "x", None).unwrap();
            assert!(!missing.exists());
            // move_aside never replaces an existing name, a link included: it picks a free one
            fs::write(r.data.join("entries.json"), "{\"entries\":[]}").unwrap();
            let victim = r.other.join("victim-aside");
            fs::write(&victim, "keep").unwrap();
            symlink(&victim, r.data.join("entries.broken-2-b.json")).unwrap();
            symlink(&missing, r.data.join("entries.broken-3-c.json")).unwrap();
            let used = move_aside(&r.data, "entries.json", "entries.broken-2-b.json").unwrap();
            assert!(used != "entries.broken-2-b.json" && used != "entries.broken-3-c.json");
            assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
            assert!(!missing.exists());
            assert_eq!(
                fs::read_to_string(r.data.join(&used)).unwrap(),
                "{\"entries\":[]}"
            );
            // moving a linked entries.json aside moves the link itself, not its target
            let real = r.other.join("real.json");
            fs::write(&real, "{\"entries\":[]}").unwrap();
            let _ = fs::remove_file(r.data.join("entries.json"));
            symlink(&real, r.data.join("entries.json")).unwrap();
            let moved = move_aside(&r.data, "entries.json", "entries.broken-4-d.json").unwrap();
            assert!(
                real.exists()
                    && fs::symlink_metadata(r.data.join(moved))
                        .unwrap()
                        .file_type()
                        .is_symlink()
            );
        }

        #[test]
        fn a_hard_link_victim_keeps_its_inode_and_content() {
            use std::os::unix::fs::MetadataExt;
            let r = rig();
            let victim = r.other.join("victim");
            fs::write(&victim, "precious").unwrap();
            fs::hard_link(&victim, r.data.join("entries.json")).unwrap();
            let before = fs::metadata(&victim).unwrap();
            write(&r.data, "entries.json", "{\"entries\":[]}", None).unwrap();
            let after = fs::metadata(&victim).unwrap();
            assert_eq!(before.ino(), after.ino());
            assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
            assert_ne!(
                fs::metadata(r.data.join("entries.json")).unwrap().ino(),
                before.ino(),
                "the data file is a new inode"
            );
            assert_eq!(
                fs::read_to_string(r.data.join("entries.json")).unwrap(),
                "{\"entries\":[]}"
            );
        }

        #[test]
        fn a_data_folder_that_is_itself_a_link_is_allowed() {
            let d = tempfile::tempdir().unwrap();
            let real = d.path().join("real-data");
            fs::create_dir_all(&real).unwrap();
            let linked = d.path().join("MoneyBar");
            symlink(&real, &linked).unwrap();
            write(&linked, "entries.json", "{\"entries\":[]}", None).unwrap();
            write(&linked, "entries.backup.json", "{\"entries\":[]}", None).unwrap();
            assert_eq!(
                read(&linked, "entries.json").unwrap().as_deref(),
                Some("{\"entries\":[]}")
            );
            assert!(
                real.join("entries.json").is_file() && real.join("entries.backup.json").is_file()
            );
            // and a link inside it is still judged by the same rules
            let victim = d.path().join("victim");
            fs::write(&victim, "x").unwrap();
            fs::remove_file(real.join("entries.json")).unwrap();
            symlink(&victim, real.join("entries.json")).unwrap();
            assert!(write(&linked, "entries.json", "{\"entries\":[]}", None).is_err());
            assert_eq!(fs::read_to_string(&victim).unwrap(), "x");
        }

        #[test]
        fn export_into_a_linked_folder_is_allowed_only_for_a_normal_folder_outside_the_data_folder()
        {
            let d = tempfile::tempdir().unwrap();
            let data = d.path().join("data");
            let real_out = d.path().join("real-out");
            fs::create_dir_all(&data).unwrap();
            fs::create_dir_all(&real_out).unwrap();
            symlink(&real_out, d.path().join("out-link")).unwrap();
            symlink(&data, d.path().join("data-link")).unwrap();
            let ok = d.path().join("out-link").join("r.csv");
            export_csv(ok.to_str().unwrap(), "a", &data).unwrap();
            assert!(real_out.join("r.csv").is_file());
            let bad = d.path().join("data-link").join("r.csv");
            assert!(
                export_csv(bad.to_str().unwrap(), "a", &data).is_err(),
                "a link to the data folder is the data folder"
            );
            assert!(!data.join("r.csv").exists());
            // a link to a file, a link to a folder, as the target
            let victim = d.path().join("victim.txt");
            fs::write(&victim, "keep").unwrap();
            symlink(&victim, real_out.join("l.csv")).unwrap();
            assert!(export_csv(real_out.join("l.csv").to_str().unwrap(), "a", &data).is_err());
            assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
        }
    }

    #[test]
    fn what_counts_as_a_money_bar_file() {
        for ok in [
            "",
            "  \n",
            "{\"entries\":[]}",
            "{\"version\":1}",
            "{\"settings\":{}}",
            "{\"version\":2,\"future\":1,\"entries\":[]}",
            "\u{FEFF}{\"entries\":[]}",
        ] {
            assert!(is_app_json(ok), "{ok:?}");
        }
        for bad in [
            "{}",
            "[]",
            "null",
            "5",
            "{\"entries\":{}}",
            "{\"version\":\"1\"}",
            "{\"name\":\"x\"}",
            "alias a=b",
            "{\"entries\":[]",
            "\"entries\"",
        ] {
            assert!(!is_app_json(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_export_runs_only_on_the_path_the_dialog_returned() {
        use std::sync::Mutex;
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        let out = d.path().join("out");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&out).unwrap();
        let last = Mutex::new(None);
        // cancelled: nothing written
        assert_eq!(
            run_export(|_| None, "x.csv", "a", &data, &last).unwrap(),
            None
        );
        assert!(fs::read_dir(&out).unwrap().next().is_none());
        // the suggestion is sanitised before the dialog sees it
        let mut seen = String::new();
        run_export(
            |n| {
                seen = n.to_string();
                None
            },
            "../../etc/pass wd?.csv",
            "a",
            &data,
            &last,
        )
        .unwrap();
        assert_eq!(seen, "etcpass wd.csv");
        assert_eq!(suggested_csv_name(""), "money-bar-report.csv");
        assert_eq!(suggested_csv_name("..."), "money-bar-report.csv");
        assert_eq!(suggested_csv_name("a/b\\c:d.CSV"), "abcd.csv");
        // a path the dialog returns is validated again: not .csv, inside the data folder, relative
        for bad in [
            out.join("x.txt"),
            data.join("x.csv"),
            PathBuf::from("rel.csv"),
        ] {
            assert!(
                run_export(|_| Some(bad.clone()), "x", "a", &data, &last).is_err(),
                "{bad:?}"
            );
        }
        assert!(!out.join("x.txt").exists() && !data.join("x.csv").exists());
        // the chosen path is the one written, with a BOM; the folder is remembered
        let target = out.join("r.csv");
        let got = run_export(|_| Some(target.clone()), "r", "hello", &data, &last).unwrap();
        assert_eq!(got.as_deref(), target.to_str());
        assert_eq!(
            fs::read(&target).unwrap(),
            [&[0xEF, 0xBB, 0xBF][..], b"hello"].concat()
        );
        assert_eq!(
            last.lock().unwrap().as_deref(),
            out.canonicalize().ok().as_deref()
        );
        // the temp file of an export lives in the data folder (same filesystem) and is gone afterwards
        assert_eq!(fs::read_dir(&data).unwrap().count(), 0);
    }

    #[test]
    fn a_read_only_target_is_refused_and_stale_export_temps_are_cleaned() {
        use std::sync::Mutex;
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        let out = d.path().join("out");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&out).unwrap();
        let ro = out.join("ro.csv");
        fs::write(&ro, "keep").unwrap();
        let mut p = fs::metadata(&ro).unwrap().permissions();
        p.set_readonly(true);
        fs::set_permissions(&ro, p).unwrap();
        let e = export_csv(ro.to_str().unwrap(), "new", &data).unwrap_err();
        assert!(e.contains("read-only"), "{e}");
        assert_eq!(fs::read_to_string(&ro).unwrap(), "keep");
        // stale temps: only the right shape, only in the folders used
        let stale = out.join(".moneybar-export.tmp-1-2");
        fs::write(&stale, "x").unwrap();
        fs::write(out.join(".moneybar-export.tmp-abc"), "x").unwrap();
        fs::write(out.join("keep.csv"), "x").unwrap();
        assert_eq!(remove_export_temps(&out, 3600), 0, "a fresh temp is kept");
        assert_eq!(remove_export_temps(&out, 0), 1);
        assert!(out.join(".moneybar-export.tmp-abc").exists() && out.join("keep.csv").exists());
        let last = Mutex::new(Some(out.clone()));
        fs::write(&stale, "x").unwrap();
        run_export(|_| None, "x", "a", &data, &last).unwrap();
        assert!(stale.exists(), "younger than an hour: still there");
    }

    #[test]
    fn compare_and_swap_refuses_a_stale_stamp_and_writes_nothing() {
        let d = tempfile::tempdir().unwrap();
        // must-not-exist: ok when absent, a conflict when present
        write(d.path(), "entries.json", "{\"entries\":[]}", Some(None)).unwrap();
        assert_eq!(
            write(d.path(), "entries.json", "{\"entries\":[1]}", Some(None)).unwrap_err(),
            CONFLICT
        );
        let s1 = stat(d.path(), "entries.json").unwrap().unwrap();
        write(
            d.path(),
            "entries.json",
            "{\"entries\":[2]}",
            Some(Some(s1.clone())),
        )
        .unwrap();
        // s1 is now stale
        assert_eq!(
            write(
                d.path(),
                "entries.json",
                "{\"entries\":[3]}",
                Some(Some(s1.clone()))
            )
            .unwrap_err(),
            CONFLICT
        );
        assert_eq!(
            read(d.path(), "entries.json").unwrap().as_deref(),
            Some("{\"entries\":[2]}")
        );
        assert!(
            fs::read_dir(d.path()).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")),
            "the temp file is removed after a conflict"
        );
        // no check: written regardless
        write(d.path(), "entries.json", "{\"entries\":[4]}", None).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_with_the_same_size_and_mtime_is_a_conflict() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "entries.json", "{\"entries\":[111]}", None).unwrap();
        let s1 = stat(d.path(), "entries.json").unwrap().unwrap();
        let mtime = fs::metadata(d.path().join("entries.json"))
            .unwrap()
            .modified()
            .unwrap();
        // an editor that saves by replacing the file: same size, same modification time, new inode
        fs::write(d.path().join("new.tmp"), "{\"entries\":[222]}").unwrap();
        fs::File::options()
            .write(true)
            .open(d.path().join("new.tmp"))
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        fs::rename(d.path().join("new.tmp"), d.path().join("entries.json")).unwrap();
        let s2 = stat(d.path(), "entries.json").unwrap().unwrap();
        assert_eq!((s1.size, s1.mtime_us), (s2.size, s2.mtime_us));
        assert_ne!(s1, s2);
        assert_eq!(
            write(d.path(), "entries.json", "x", Some(Some(s1.clone()))).unwrap_err(),
            CONFLICT
        );
    }

    #[test]
    fn same_size_mtime_ctime_and_inode_but_other_content_is_a_different_stamp() {
        // FAT/exFAT keep modification times to 2 s and have no useful inode or change time: the content hash is what tells
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "entries.json", "{\"entries\":[111]}", None).unwrap();
        let s1 = stat(d.path(), "entries.json").unwrap().unwrap();
        write(d.path(), "entries.json", "{\"entries\":[222]}", None).unwrap();
        let s2 = stat(d.path(), "entries.json").unwrap().unwrap();
        assert_eq!(s1.size, s2.size);
        assert_ne!(s1.hash, s2.hash);
        let coarse = Stamp {
            mtime_us: s1.mtime_us,
            ctime_us: s1.ctime_us,
            ino: s1.ino.clone(),
            ..s2.clone()
        };
        assert_ne!(s1, coarse);
        assert_eq!(
            write(d.path(), "entries.json", "x", Some(Some(s1))).unwrap_err(),
            CONFLICT
        );
        // and the same content stays the same stamp
        assert_eq!(stat(d.path(), "entries.json").unwrap().unwrap(), s2);
    }

    #[test]
    fn a_stamp_from_an_older_page_without_a_hash_still_parses() {
        let s: Stamp =
            serde_json::from_str(r#"{"size":1,"mtimeUs":2,"ctimeUs":3,"ino":"4"}"#).unwrap();
        assert_eq!(s.hash, "");
    }

    #[test]
    fn two_writers_with_compare_and_swap_and_retry_lose_nothing() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "entries.json", "{\"entries\":[]}", Some(None)).unwrap();
        let path = d.path().to_path_buf();
        let mut handles = vec![];
        for w in 0..2u32 {
            let p = path.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..30u32 {
                    loop {
                        let before = stat(&p, "entries.json").unwrap().unwrap();
                        let text = read(&p, "entries.json").unwrap().unwrap();
                        let mut v: serde_json::Value = serde_json::from_str(&text).unwrap();
                        v["entries"]
                            .as_array_mut()
                            .unwrap()
                            .push(serde_json::json!(format!("w{w}-{i}")));
                        match write(&p, "entries.json", &v.to_string(), Some(Some(before))) {
                            Ok(()) => break,
                            Err(e) if e == CONFLICT => continue,
                            Err(e) => panic!("{e}"),
                        }
                    }
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let v: serde_json::Value =
            serde_json::from_str(&read(&path, "entries.json").unwrap().unwrap()).unwrap();
        assert_eq!(
            v["entries"].as_array().unwrap().len(),
            60,
            "every append survived"
        );
        assert!(!names_of(&path).iter().any(|n| n.contains(".tmp-")));
    }

    fn names_of(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_named_entries_json_is_never_opened_and_a_huge_file_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let fifo = d.path().join("entries.json");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: a valid NUL-terminated path and a plain mode.
        if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } == 0 {
            let started = std::time::Instant::now();
            assert!(read(d.path(), "entries.json")
                .unwrap_err()
                .contains("not a regular file"));
            assert!(
                started.elapsed() < std::time::Duration::from_secs(2),
                "stat first: no blocking open"
            );
            assert!(
                write(d.path(), "entries.json", "x", None).is_err()
                    || fs::symlink_metadata(&fifo).is_ok()
            );
            fs::remove_file(&fifo).unwrap();
        }
        let big = d.path().join("entries.json");
        fs::File::create(&big)
            .unwrap()
            .set_len(MAX_READ_BYTES + 1)
            .unwrap();
        assert!(read(d.path(), "entries.json")
            .unwrap_err()
            .contains("larger than 32 MB"));
        fs::File::create(&big)
            .unwrap()
            .set_len(MAX_READ_BYTES)
            .unwrap();
        assert!(
            read(d.path(), "entries.json").is_ok()
                || read(d.path(), "entries.json")
                    .unwrap_err()
                    .contains("UTF-8"),
            "exactly 32 MB is allowed by the cap"
        );
    }

    #[test]
    fn utf16_and_bom_text() {
        let d = tempfile::tempdir().unwrap();
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(
                "{\"entries\":[]}"
                    .encode_utf16()
                    .flat_map(|u| u.to_le_bytes()),
            )
            .collect();
        fs::write(d.path().join("entries.json"), &utf16).unwrap();
        assert!(read(d.path(), "entries.json")
            .unwrap_err()
            .contains("save it again as UTF-8"));
        fs::write(d.path().join("entries.json"), "\u{FEFF}{\"entries\":[]}").unwrap();
        assert!(
            read(d.path(), "entries.json")
                .unwrap()
                .unwrap()
                .starts_with('\u{FEFF}'),
            "the BOM is passed on; the page strips it"
        );
    }

    #[test]
    fn a_read_only_data_file_is_refused() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "entries.json", "{\"entries\":[]}", None).unwrap();
        let mut p = fs::metadata(d.path().join("entries.json"))
            .unwrap()
            .permissions();
        p.set_readonly(true);
        fs::set_permissions(d.path().join("entries.json"), p).unwrap();
        assert!(write(d.path(), "entries.json", "{\"entries\":[1]}", None)
            .unwrap_err()
            .contains("read-only"));
        assert_eq!(
            fs::read_to_string(d.path().join("entries.json")).unwrap(),
            "{\"entries\":[]}"
        );
    }

    #[test]
    fn transient_rename_errors_are_recognised() {
        assert!(is_transient(&std::io::Error::from(
            std::io::ErrorKind::PermissionDenied
        )));
        assert!(is_transient(&std::io::Error::from_raw_os_error(32)));
        assert!(is_transient(&std::io::Error::from_raw_os_error(5)));
        assert!(!is_transient(&std::io::Error::from(
            std::io::ErrorKind::NotFound
        )));
        assert_eq!(RETRY_DELAYS_MS.iter().sum::<u64>(), 770);
        let d = tempfile::tempdir().unwrap();
        assert!(
            rename_retry(&d.path().join("missing"), &d.path().join("x")).is_err(),
            "a real error is not retried forever"
        );
    }

    #[test]
    fn a_stamp_survives_the_trip_through_json_as_the_page_sends_it_back() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..200 {
            write(
                d.path(),
                "entries.json",
                &format!("{{\"entries\":[{i}]}}"),
                None,
            )
            .unwrap();
            let s = stat(d.path(), "entries.json").unwrap().unwrap();
            // what the webview does: JSON out of fs_stat, a JS number in memory, JSON back into fs_write
            let js: serde_json::Value =
                serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
            let back: Stamp = serde_json::from_value(
                serde_json::from_str::<serde_json::Value>(&js.to_string()).unwrap(),
            )
            .unwrap();
            assert_eq!(s, back);
            write(
                d.path(),
                "entries.json",
                "{\"entries\":[]}",
                Some(Some(back)),
            )
            .unwrap();
        }
    }

    #[test]
    fn stamps_survive_json_exactly_200000_random_ones() {
        let mut x: u64 = 0x9E3779B97F4A7C15;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for i in 0..200_000u64 {
            let r = next();
            let mtime_us = match i % 4 {
                0 => (r % 4_000_000_000_000_000) as i64, // up to the year 2096
                1 => -((r % 2_000_000_000_000_000) as i64), // before 1970
                2 => 9_007_199_254_740_991 - (r % 1000) as i64, // the top of the exact range
                _ => (r % 1_800_000_000_000_000) as i64 + 123,
            };
            let s = Stamp {
                size: r >> 20,
                mtime_us,
                ctime_us: (next() % 4_000_000_000_000_000) as i64,
                ino: (next() >> 1).to_string(),
                hash: format!("{:016x}", next()),
            };
            let through_js: serde_json::Value =
                serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
            let text = serde_json::to_string(&through_js).unwrap();
            let back: Stamp = serde_json::from_str(&text).unwrap();
            assert_eq!(s, back);
        }
    }

    #[test]
    fn one_microsecond_one_byte_or_another_inode_make_a_different_stamp() {
        let a = Stamp {
            size: 10,
            mtime_us: 1_760_000_000_000_000,
            ctime_us: 1_760_000_000_000_000,
            ino: "5".into(),
            hash: "00".into(),
        };
        assert_eq!(a, a.clone());
        assert_ne!(
            a,
            Stamp {
                hash: "01".into(),
                ..a.clone()
            }
        );
        assert_ne!(
            a,
            Stamp {
                mtime_us: a.mtime_us + 1,
                ..a.clone()
            }
        );
        assert_ne!(
            a,
            Stamp {
                ctime_us: a.ctime_us + 1,
                ..a.clone()
            }
        );
        assert_ne!(
            a,
            Stamp {
                size: 11,
                ..a.clone()
            }
        );
        assert_ne!(
            a,
            Stamp {
                ino: "6".into(),
                ..a.clone()
            }
        );
    }

    #[test]
    fn save_after_save_with_the_returned_stamp_never_conflicts() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "entries.json", "{\"entries\":[]}", Some(None)).unwrap();
        // 2,000 fsynced saves on Unix; fewer on Windows where each save is slower
        for i in 0..(if cfg!(windows) { 300 } else { 2000 }) {
            let s = stat(d.path(), "entries.json").unwrap().unwrap();
            // what the page does with it: out as JSON, a JS object in memory, back in as JSON
            let back: Stamp = serde_json::from_str(
                &serde_json::to_string(
                    &serde_json::from_str::<serde_json::Value>(&serde_json::to_string(&s).unwrap())
                        .unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
            write(
                d.path(),
                "entries.json",
                &format!("{{\"entries\":[{i}]}}"),
                Some(Some(back)),
            )
            .unwrap_or_else(|e| panic!("save {i}: {e}"));
        }
    }
}
