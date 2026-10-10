//! Where entries.json live. Pure: the OS and the environment are passed in, so every OS is tested on any OS.

use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Os::Mac => "macos",
            Os::Windows => "windows",
            Os::Linux => "linux",
        }
    }
}

fn trim_end(p: &str, sep: char) -> &str {
    if p.len() > 1 && p.ends_with(sep) {
        &p[..p.len() - 1]
    } else {
        p
    }
}

fn is_absolute(p: &str, os: Os) -> bool {
    match os {
        Os::Windows => {
            let b = p.as_bytes();
            (b.len() >= 3
                && b[0].is_ascii_alphabetic()
                && b[1] == b':'
                && (b[2] == b'\\' || b[2] == b'/'))
                || p.starts_with("\\\\")
        }
        _ => p.starts_with('/'),
    }
}

/// 1. MONEYBAR_DATA_DIR (every test and manual run sets it)
/// 2. macOS ~/Library/Application Support/MoneyBar, Windows %APPDATA%\MoneyBar,
///    Linux ${XDG_DATA_HOME:-~/.local/share}/MoneyBar (an XDG_DATA_HOME that is not absolute is ignored).
///
/// `home` is None (or blank) when the OS gave no home folder; that is an error unless the answer does not need it
/// (an override, an absolute XDG_DATA_HOME, or APPDATA on Windows). It never falls back to the current folder.
pub fn default_data_dir(
    os: Os,
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(o) = env("MONEYBAR_DATA_DIR") {
        if !o.trim().is_empty() {
            return Ok(PathBuf::from(o));
        }
    }
    let sep = if os == Os::Windows { '\\' } else { '/' };
    let home = home.filter(|h| !h.trim().is_empty());
    let need_home = || {
        home.map(|h| trim_end(h, sep).to_string()).ok_or_else(|| {
            "cannot find the home folder (HOME / USERPROFILE is not set): set MONEYBAR_DATA_DIR to choose where Money Bar keeps its data"
                .to_string()
        })
    };
    let s = match os {
        Os::Mac => format!("{}/Library/Application Support/MoneyBar", need_home()?),
        Os::Windows => {
            let appdata = match env("APPDATA").filter(|a| !a.trim().is_empty()) {
                Some(a) => a,
                None => format!("{}\\AppData\\Roaming", need_home()?),
            };
            format!("{}\\MoneyBar", trim_end(&appdata, '\\'))
        }
        Os::Linux => {
            let base = match env("XDG_DATA_HOME") {
                Some(x) if is_absolute(&x, Os::Linux) => trim_end(&x, '/').to_string(),
                _ => format!("{}/.local/share", need_home()?),
            };
            format!("{base}/MoneyBar")
        }
    };
    Ok(PathBuf::from(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn mac() {
        assert_eq!(
            default_data_dir(Os::Mac, &env(&[]), Some("/Users/ann")).unwrap(),
            PathBuf::from("/Users/ann/Library/Application Support/MoneyBar")
        );
    }

    #[test]
    fn windows_uses_appdata_then_profile() {
        let e = env(&[("APPDATA", "C:\\Users\\Ann\\AppData\\Roaming")]);
        assert_eq!(
            default_data_dir(Os::Windows, &e, Some("C:\\Users\\Ann")).unwrap(),
            PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\MoneyBar")
        );
        let e = env(&[("APPDATA", "C:\\Users\\Ann\\AppData\\Roaming\\")]);
        assert_eq!(
            default_data_dir(Os::Windows, &e, Some("C:\\Users\\Ann")).unwrap(),
            PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\MoneyBar")
        );
        assert_eq!(
            default_data_dir(Os::Windows, &env(&[]), Some("C:\\Users\\Ann")).unwrap(),
            PathBuf::from("C:\\Users\\Ann\\AppData\\Roaming\\MoneyBar")
        );
    }

    #[test]
    fn linux_uses_xdg_when_absolute() {
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[]), Some("/home/ann")).unwrap(),
            PathBuf::from("/home/ann/.local/share/MoneyBar")
        );
        assert_eq!(
            default_data_dir(
                Os::Linux,
                &env(&[("XDG_DATA_HOME", "/data/xdg")]),
                Some("/home/ann")
            )
            .unwrap(),
            PathBuf::from("/data/xdg/MoneyBar")
        );
        assert_eq!(
            default_data_dir(
                Os::Linux,
                &env(&[("XDG_DATA_HOME", "relative/dir")]),
                Some("/home/ann")
            )
            .unwrap(),
            PathBuf::from("/home/ann/.local/share/MoneyBar")
        );
        assert_eq!(
            default_data_dir(
                Os::Linux,
                &env(&[("XDG_DATA_HOME", "")]),
                Some("/home/ann/")
            )
            .unwrap(),
            PathBuf::from("/home/ann/.local/share/MoneyBar")
        );
    }

    #[test]
    fn override_wins_everywhere() {
        for os in [Os::Mac, Os::Windows, Os::Linux] {
            assert_eq!(
                default_data_dir(os, &env(&[("MONEYBAR_DATA_DIR", "/tmp/x")]), Some("/h")).unwrap(),
                PathBuf::from("/tmp/x")
            );
        }
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[("MONEYBAR_DATA_DIR", "  ")]), Some("/h")).unwrap(),
            PathBuf::from("/h/.local/share/MoneyBar")
        );
    }

    #[test]
    fn a_missing_home_is_an_error_not_the_current_folder() {
        for os in [Os::Mac, Os::Windows, Os::Linux] {
            for home in [None, Some(""), Some("  ")] {
                let e = default_data_dir(os, &env(&[]), home).unwrap_err();
                assert!(e.contains("MONEYBAR_DATA_DIR"), "{e}");
            }
        }
    }

    #[test]
    fn a_missing_home_is_fine_when_the_answer_does_not_need_it() {
        assert_eq!(
            default_data_dir(Os::Windows, &env(&[("APPDATA", "C:\\A")]), None).unwrap(),
            PathBuf::from("C:\\A\\MoneyBar")
        );
        assert_eq!(
            default_data_dir(Os::Linux, &env(&[("XDG_DATA_HOME", "/x")]), None).unwrap(),
            PathBuf::from("/x/MoneyBar")
        );
        assert_eq!(
            default_data_dir(Os::Mac, &env(&[("MONEYBAR_DATA_DIR", "/t")]), None).unwrap(),
            PathBuf::from("/t")
        );
    }
}
