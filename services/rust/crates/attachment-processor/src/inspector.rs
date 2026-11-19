use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use zip::ZipArchive;

#[derive(Debug, Clone)]
pub struct InspectionLimits {
    pub max_file_bytes: u64,
    pub max_archive_entries: usize,
    pub max_uncompressed_bytes: u64,
    pub max_compression_ratio: f64,
}

impl Default for InspectionLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 25 * 1024 * 1024,          // 25 MiB
            max_archive_entries: 512,
            max_uncompressed_bytes: 100 * 1024 * 1024, // 100 MiB
            max_compression_ratio: 100.0,
        }
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ArchiveEntrySummary {
    pub name: String,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ArchiveSummary {
    pub entry_count: usize,
    pub total_uncompressed_bytes: u64,
    pub max_compression_ratio: f64,
    pub entries: Vec<ArchiveEntrySummary>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SafetyChecks {
    pub passed: bool,
    pub violations: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct InspectionReport {
    pub sha256: String,
    pub size_bytes: u64,
    pub detected_mime: String,
    pub is_archive: bool,
    pub archive_summary: Option<ArchiveSummary>,
    pub safety_checks: SafetyChecks,
}

const ALLOWED_EXTENSIONS: &[&str] = &[
    "zip", "txt", "py", "c", "cpp", "h", "rs", "go", "json", "csv", "md", "pdf", "png", "jpg",
    "jpeg", "gif", "pcap", "pcapng", "bin", "elf", "tar", "gz", "xz", "7z", "wav", "mp3",
    "ogg", "flac", "m4a", "mp4", "webm",
];

const TEXT_EXTENSIONS: &[&str] = &["txt", "py", "c", "cpp", "h", "rs", "go", "json", "csv", "md"];

const FORBIDDEN_BINARY_MIMES: &[&str] = &[
    "application/vnd.microsoft.portable-executable",
    "application/x-msdownload",
    "application/x-dosexec",
];

fn extract_extension(original_name: &str) -> Option<String> {
    Path::new(original_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
}

fn validate_mime_and_extension(
    original_name: &str,
    detected_mime: &str,
    header: &[u8],
    violations: &mut Vec<String>,
) {
    let ext = match extract_extension(original_name) {
        Some(e) if ALLOWED_EXTENSIONS.contains(&e.as_str()) => e,
        Some(e) => {
            violations.push(format!("Disallowed file extension '.{e}'"));
            return;
        }
        None => {
            violations.push("File must include an allowed extension".to_string());
            return;
        }
    };

    if FORBIDDEN_BINARY_MIMES.contains(&detected_mime) {
        violations.push(format!("Forbidden executable MIME type detected: {detected_mime}"));
        return;
    }

    // Strict magic-byte matching for structured binary/archive/image/media formats
    let expected_magic: Option<&[&str]> = match ext.as_str() {
        "zip" => Some(&["application/zip"]),
        "png" => Some(&["image/png"]),
        "jpg" | "jpeg" => Some(&["image/jpeg"]),
        "gif" => Some(&["image/gif"]),
        "pdf" => Some(&["application/pdf"]),
        "gz" => Some(&["application/gzip"]),
        "7z" => Some(&["application/x-7z-compressed"]),
        "xz" => Some(&["application/x-xz"]),
        "wav" => Some(&["audio/wav", "audio/x-wav", "audio/vnd.wave", "audio/wave"]),
        "mp3" => Some(&["audio/mpeg", "audio/mp3"]),
        "ogg" => Some(&["audio/ogg", "application/ogg", "video/ogg"]),
        "flac" => Some(&["audio/flac", "audio/x-flac"]),
        "m4a" => Some(&["audio/mp4", "audio/x-m4a", "audio/m4a"]),
        "mp4" => Some(&["video/mp4"]),
        "webm" => Some(&["video/webm", "audio/webm"]),
        _ => None,
    };

    if let Some(allowed) = expected_magic {
        if !allowed.contains(&detected_mime) {
            violations.push(format!(
                "MIME mismatch for '.{ext}': detected '{detected_mime}'"
            ));
        }
    }

    // Reject disguised HTML/SVG/binary payloads inside plain-text challenge artifacts
    if TEXT_EXTENSIONS.contains(&ext.as_str()) {
        if detected_mime != "application/octet-stream" && !detected_mime.starts_with("text/") {
            violations.push(format!(
                "Binary payload ('{detected_mime}') disguised as text extension '.{ext}'"
            ));
        } else {
            let prefix = String::from_utf8_lossy(&header[..header.len().min(512)]).to_ascii_lowercase();
            if prefix.contains("<html") || prefix.contains("<!doctype html") || prefix.contains("<svg") {
                violations.push("Disallowed HTML/SVG markup inside text attachment".to_string());
            }
        }
    }
}

fn is_unsafe_archive_path(entry_name: &str) -> bool {
    if entry_name.is_empty()
        || entry_name.starts_with('/')
        || entry_name.starts_with('\\')
        || entry_name.contains('\0')
        || entry_name.contains('\\')
    {
        return true;
    }
    if entry_name.as_bytes().get(1) == Some(&b':') {
        return true;
    }
    entry_name.split('/').any(|seg| seg == "..")
}

pub fn inspect_file(
    path: &Path,
    original_name: &str,
    limits: &InspectionLimits,
) -> Result<InspectionReport, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    let metadata = file.metadata().map_err(|e| format!("Metadata error: {e}"))?;
    let size_bytes = metadata.len();

    let mut violations = Vec::new();
    if size_bytes == 0 {
        violations.push("Empty file uploads are not permitted".to_string());
    }
    if size_bytes > limits.max_file_bytes {
        violations.push(format!(
            "File size {size_bytes} exceeds limit {}",
            limits.max_file_bytes
        ));
    }

    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut magic_buf = Vec::with_capacity(8192);
    let mut buf = [0u8; 65536];

    loop {
        let read = reader.read(&mut buf).map_err(|e| format!("Read error: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        if magic_buf.len() < 8192 {
            let take = (8192 - magic_buf.len()).min(read);
            magic_buf.extend_from_slice(&buf[..take]);
        }
    }

    let sha256 = hex::encode(hasher.finalize());
    let detected_mime = infer::get(&magic_buf)
        .map(|k| k.mime_type().to_string())
        .unwrap_or_else(|| "application/octet-stream".to_string());

    validate_mime_and_extension(original_name, &detected_mime, &magic_buf, &mut violations);

    let ext = extract_extension(original_name).unwrap_or_default();
    let is_zip = detected_mime == "application/zip" || ext == "zip";
    let mut archive_summary = None;

    if is_zip && violations.is_empty() {
        let zip_file = File::open(path).map_err(|e| format!("Reopen zip error: {e}"))?;
        match ZipArchive::new(zip_file) {
            Ok(mut archive) => {
                let entry_count = archive.len();
                if entry_count > limits.max_archive_entries {
                    violations.push(format!(
                        "Archive entry count {entry_count} exceeds limit {}",
                        limits.max_archive_entries
                    ));
                }

                let mut total_uncompressed: u64 = 0;
                let mut max_ratio: f64 = 0.0;
                let mut entries = Vec::with_capacity(entry_count.min(limits.max_archive_entries));

                for i in 0..entry_count.min(limits.max_archive_entries) {
                    let entry = match archive.by_index_raw(i) {
                        Ok(e) => e,
                        Err(e) => {
                            violations.push(format!("Malformed ZIP entry at index {i}: {e}"));
                            break;
                        }
                    };

                    let name = entry.name().to_string();
                    if is_unsafe_archive_path(&name) {
                        violations.push(format!("Unsafe archive entry path detected: {name}"));
                    }

                    let compressed = entry.compressed_size();
                    let uncompressed = entry.size();
                    total_uncompressed = total_uncompressed.saturating_add(uncompressed);

                    let ratio = if compressed > 0 {
                        uncompressed as f64 / compressed as f64
                    } else if uncompressed > 0 {
                        f64::INFINITY
                    } else {
                        1.0
                    };

                    if ratio > max_ratio {
                        max_ratio = ratio;
                    }
                    if ratio > limits.max_compression_ratio {
                        violations.push(format!(
                            "Archive bomb suspected on '{name}': compression ratio {ratio:.1}x exceeds limit {:.1}x",
                            limits.max_compression_ratio
                        ));
                    }

                    entries.push(ArchiveEntrySummary {
                        name,
                        compressed_bytes: compressed,
                        uncompressed_bytes: uncompressed,
                        is_dir: entry.is_dir(),
                    });
                }

                if total_uncompressed > limits.max_uncompressed_bytes {
                    violations.push(format!(
                        "Total uncompressed size {total_uncompressed} exceeds limit {}",
                        limits.max_uncompressed_bytes
                    ));
                }

                archive_summary = Some(ArchiveSummary {
                    entry_count,
                    total_uncompressed_bytes: total_uncompressed,
                    max_compression_ratio: max_ratio,
                    entries,
                });
            }
            Err(e) => {
                violations.push(format!("Malformed ZIP archive: {e}"));
            }
        }
    }

    Ok(InspectionReport {
        sha256,
        size_bytes,
        detected_mime,
        is_archive: is_zip,
        archive_summary,
        safety_checks: SafetyChecks {
            passed: violations.is_empty(),
            violations,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    #[test]
    fn computes_exact_sha256_known_vector() {
        let mut tmp = NamedTempFile::new().unwrap();
        tmp.write_all(b"abc").unwrap();
        tmp.flush().unwrap();

        let report = inspect_file(tmp.path(), "notes.txt", &InspectionLimits::default()).unwrap();
        assert!(report.safety_checks.passed);
        assert_eq!(
            report.sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn enforces_file_size_limit() {
        let mut tmp = NamedTempFile::new().unwrap();
        tmp.write_all(b"0123456789abcdef").unwrap();
        tmp.flush().unwrap();

        let tight = InspectionLimits {
            max_file_bytes: 8,
            ..Default::default()
        };
        let report = inspect_file(tmp.path(), "data.bin", &tight).unwrap();
        assert!(!report.safety_checks.passed);
        assert!(report.safety_checks.violations.iter().any(|v| v.contains("exceeds limit")));
    }

    #[test]
    fn validates_mime_and_rejects_spoofed_extensions() {
        let mut tmp = NamedTempFile::new().unwrap();
        // MZ PE header disguised as .png
        tmp.write_all(b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff").unwrap();
        tmp.flush().unwrap();

        let report = inspect_file(tmp.path(), "avatar.png", &InspectionLimits::default()).unwrap();
        assert!(!report.safety_checks.passed);

        let mut html_tmp = NamedTempFile::new().unwrap();
        html_tmp.write_all(b"<!DOCTYPE html><script>alert(1)</script>").unwrap();
        html_tmp.flush().unwrap();
        let html_report = inspect_file(html_tmp.path(), "readme.txt", &InspectionLimits::default()).unwrap();
        assert!(!html_report.safety_checks.passed);
    }

    #[test]
    fn enforces_archive_entry_limit() {
        let tmp = NamedTempFile::new().unwrap();
        {
            let mut zw = ZipWriter::new(tmp.reopen().unwrap());
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            for i in 0..5 {
                zw.start_file(format!("file_{i}.txt"), opts).unwrap();
                zw.write_all(b"hi").unwrap();
            }
            zw.finish().unwrap();
        }

        let limits = InspectionLimits {
            max_archive_entries: 3,
            ..Default::default()
        };
        let report = inspect_file(tmp.path(), "bundle.zip", &limits).unwrap();
        assert!(!report.safety_checks.passed);
        assert!(report.safety_checks.violations.iter().any(|v| v.contains("entry count")));
    }

    #[test]
    fn rejects_zip_path_traversal() {
        let tmp = NamedTempFile::new().unwrap();
        {
            let mut zw = ZipWriter::new(tmp.reopen().unwrap());
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            zw.start_file("../../etc/passwd", opts).unwrap();
            zw.write_all(b"root:x:0:0").unwrap();
            zw.finish().unwrap();
        }

        let report = inspect_file(tmp.path(), "chal.zip", &InspectionLimits::default()).unwrap();
        assert!(!report.safety_checks.passed);
        assert!(report
            .safety_checks
            .violations
            .iter()
            .any(|v| v.contains("Unsafe archive entry path")));
    }

    #[test]
    fn rejects_high_ratio_zip_bomb() {
        let tmp = NamedTempFile::new().unwrap();
        {
            let mut zw = ZipWriter::new(tmp.reopen().unwrap());
            let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zw.start_file("zeros.bin", opts).unwrap();
            zw.write_all(&vec![0u8; 512 * 1024]).unwrap();
            zw.finish().unwrap();
        }

        let report = inspect_file(tmp.path(), "bomb.zip", &InspectionLimits::default()).unwrap();
        assert!(!report.safety_checks.passed);
        assert!(report
            .safety_checks
            .violations
            .iter()
            .any(|v| v.contains("Archive bomb suspected")));
    }

    #[test]
    fn rejects_malformed_zip_archive() {
        let mut tmp = NamedTempFile::new().unwrap();
        // Valid ZIP local header prefix followed by garbage bytes
        tmp.write_all(b"PK\x03\x04corrupted_not_a_valid_archive").unwrap();
        tmp.flush().unwrap();

        let report = inspect_file(tmp.path(), "broken.zip", &InspectionLimits::default()).unwrap();
        assert!(!report.safety_checks.passed);
        assert!(report
            .safety_checks
            .violations
            .iter()
            .any(|v| v.contains("Malformed ZIP")));
    }
}
