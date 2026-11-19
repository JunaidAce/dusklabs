mod inspector;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use inspector::{inspect_file, InspectionLimits, InspectionReport};
use serde::Deserialize;
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tower_http::limit::RequestBodyLimitLayer;

#[derive(Clone)]
struct AppState {
    internal_token: String,
    upload_root: PathBuf,
}

#[derive(Deserialize)]
struct InspectRequest {
    relative_key: String,
    original_name: String,
    max_file_bytes: Option<u64>,
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in ab.iter().zip(bb.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn health() -> &'static str {
    "ok"
}

async fn handle_inspect(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<InspectRequest>,
) -> Result<Json<InspectionReport>, (StatusCode, String)> {
    let auth = headers
        .get("x-internal-service-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !constant_time_eq(auth, &state.internal_token) {
        return Err((StatusCode::UNAUTHORIZED, "Unauthorized internal caller".into()));
    }

    if payload.relative_key.is_empty()
        || payload.relative_key.contains("..")
        || payload.relative_key.contains('/')
        || payload.relative_key.contains('\\')
        || payload.relative_key.contains('\0')
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid storage key".into()));
    }

    let root_canon = std::fs::canonicalize(&state.upload_root)
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Upload vault unavailable".into()))?;
    let target = std::fs::canonicalize(root_canon.join(&payload.relative_key))
        .map_err(|_| (StatusCode::BAD_REQUEST, "Target artifact not found".into()))?;

    if !target.starts_with(&root_canon) {
        return Err((StatusCode::BAD_REQUEST, "Path escapes vault".into()));
    }

    let mut limits = InspectionLimits::default();
    if let Some(max) = payload.max_file_bytes {
        limits.max_file_bytes = max;
    }

    let orig = payload.original_name;
    let report = tokio::task::spawn_blocking(move || inspect_file(&target, &orig, &limits))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    Ok(Json(report))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();

    let internal_token =
        std::env::var("RUST_INTERNAL_TOKEN").unwrap_or_else(|_| "dev-internal-token-change-me".into());
    let upload_root = PathBuf::from(
        std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "../../apps/api/storage/attachments".into()),
    );
    std::fs::create_dir_all(&upload_root).expect("Failed to initialize UPLOAD_DIR");

    let state = Arc::new(AppState {
        internal_token,
        upload_root,
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/internal/v1/attachments/inspect", post(handle_inspect))
        .layer(RequestBodyLimitLayer::new(64 * 1024))
        .with_state(state);

    let bind_addr = std::env::var("RUST_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:4100".into());
    let addr: SocketAddr = bind_addr.parse().expect("Invalid RUST_BIND_ADDR");
    tracing::info!(%addr, "attachment-processor listening");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
