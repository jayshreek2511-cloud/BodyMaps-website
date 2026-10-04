import sys
import os
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.serving import run_simple
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))
#print("DEBUG_ENV_LOADED:", os.environ.get("SESSIONS_DIR_PATH"))

from flask import Flask
from flask_cors import CORS
from constants import Constants
#print("DEBUG_CONSTANT:", Constants.SESSIONS_DIR_NAME)

from api.api_blueprint import api_blueprint
from api.education import education_blueprint
from api.live_rooms import live_rooms_blueprint
from api.auth_blueprint import auth_blueprint
from api.oauth_blueprint import init_oauth, oauth_blueprint
from api.admin_blueprint import admin_blueprint
from api.analytics_blueprint import analytics_blueprint
from models.base import db
from models.combined_labels import CombinedLabels
from models.engine import get_engine

def create_session_dir():
    if not os.path.isdir(Constants.SESSIONS_DIR_NAME):
        os.mkdir(Constants.SESSIONS_DIR_NAME)

import logging

def create_app():
    create_session_dir()
    app = Flask(__name__)

    # Behind nginx, the real scheme, host and client address arrive as
    # X-Forwarded-Proto/Host/For; without this Flask sees the proxy's
    # http://127.0.0.1 hop. Two things break on that: the OAuth redirect_uri
    # (built from request.url_root) comes out http:// and fails to match what's
    # registered with Google/GitHub, and request.remote_addr is the proxy — so
    # every visitor geolocates to the server itself and the whole site shares
    # one rate-limit bucket. Opt-in because these headers are client-spoofable
    # when nothing trusted is in front of the app.
    #
    # TRUST_PROXY_HOPS is how many proxies are in front of the app, and it must
    # match the deployment exactly. ProxyFix counts from the RIGHT of
    # X-Forwarded-For, so the value is "how many entries at the end of that
    # header were written by infrastructure I control".
    #
    # Too low and you read a proxy's own address instead of the visitor's. Too
    # high and you read whatever the client put there — anyone can send an
    # X-Forwarded-For header, so an over-count is a spoofing hole, which is why
    # this defaults to 1 rather than to something permissive.
    #
    # bodymaps.wse.jhu.edu sits behind two: a campus edge proxy and nginx, so it
    # sets 2. Check yours rather than guessing — restart gunicorn with
    #   --access-logformat "XFF=[%({X-Forwarded-For}i)s]"
    # and count the entries on a request from OUTSIDE the network. Traffic from
    # inside is NAT'd and shows a private address where the visitor's should be,
    # which makes an internal test look like a broken one.
    if os.environ.get("TRUST_PROXY", "false").lower() == "true":
        try:
            hops = max(1, int(os.environ.get("TRUST_PROXY_HOPS", "1")))
        except ValueError:
            hops = 1
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=hops, x_proto=1, x_host=1)

    app.register_blueprint(api_blueprint, url_prefix=f'{Constants.BASE_PATH}/api')
    app.register_blueprint(education_blueprint, url_prefix=f'{Constants.BASE_PATH}/api')
    app.register_blueprint(live_rooms_blueprint, url_prefix=f'{Constants.BASE_PATH}/api')
    app.register_blueprint(auth_blueprint, url_prefix=f'{Constants.BASE_PATH}/api')
    app.register_blueprint(oauth_blueprint, url_prefix=f'{Constants.BASE_PATH}/api')
    app.register_blueprint(admin_blueprint, url_prefix=f'{Constants.BASE_PATH}/api')
    app.register_blueprint(analytics_blueprint, url_prefix=f'{Constants.BASE_PATH}/api')

    app.config['MAX_CONTENT_LENGTH'] = 2 * 1024 * 1024 * 1024  # 2 GB, for overcoming size limits in file uploads

    # Signs the Flask session cookie, which Authlib uses to carry the OAuth
    # `state` (CSRF) between the redirect and the callback. In production this
    # MUST be a fixed secret from the environment — a random per-boot value
    # would invalidate every in-flight OAuth login on restart.
    secret = os.environ.get("SECRET_KEY")
    if not secret:
        secret = os.urandom(32).hex()
        print("[boot] SECRET_KEY not set — using an ephemeral key (OAuth logins "
              "in flight will break on restart). Set SECRET_KEY in production.")
    app.config['SECRET_KEY'] = secret

    # Registers only the OAuth providers whose credentials are configured, so
    # the app boots fine without them (buttons stay disabled in the UI).
    init_oauth(app)

    # Point Flask-SQLAlchemy at the same URL as the job store. FSA builds its own
    # engine, but both get identical SQLite PRAGMAs from the process-wide listener
    # in models/engine.py. Schema is managed by Alembic, not create_all.
    app.config['SQLALCHEMY_DATABASE_URI'] = Constants.DATABASE_URL
    app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {}
    db.init_app(app)
    with app.app_context():
        get_engine()  # init at boot, not first request

    # Seed the reserved system user first (legacy-imported jobs are assigned to
    # it, and job.user_id is NOT NULL with an FK), then import any pre-DB
    # job.json, then fail jobs orphaned by the restart.
    try:
        from services import auth_store, job_store
        auth_store.ensure_system_user()
        imported = job_store.import_legacy_job_json(Constants.SESSIONS_DIR_NAME)
        if imported:
            print(f"[boot] imported {imported} legacy job.json record(s)")
        reaped = job_store.reap_orphaned_jobs()
        if reaped:
            print(f"[boot] reaped {reaped} orphaned inference job(s)")
        # Accounts whose 30-day grace period elapsed while the server was up (or
        # down) are removed for good here. Boot is the only trigger for now — a
        # long-running server won't purge until its next restart, which is fine:
        # the account is already unusable from the moment it's requested.
        purged = auth_store.purge_expired_deletions()
        if purged:
            print(f"[boot] purged {purged} account(s) past the deletion grace period")
        # Same deal for spent reset tokens: housekeeping, not security — they
        # are already refused on redemption, this just stops the table growing.
        dropped = auth_store.purge_expired_reset_tokens()
        dropped += auth_store.purge_expired_verification_tokens()
        if dropped:
            print(f"[boot] dropped {dropped} spent password reset token(s)")
    except Exception as e:
        print(f"[boot] account/job store init skipped: {e}")

    class FilterProgressRequests(logging.Filter):
        def filter(self, record):
            return "/api/progress/" not in record.getMessage()

    logging.getLogger('werkzeug').addFilter(FilterProgressRequests())

    # Pin CORS to an explicit allowlist and allow credentials — required now that
    # auth rides in a cookie (a wildcard origin can't be combined with cookies,
    # and would let any site make authenticated requests as a logged-in user).
    # Set ALLOWED_ORIGINS on the server (comma-separated); defaults to local dev.
    # Both localhost spellings by default: the browser treats localhost and
    # 127.0.0.1 as different origins, and opening the dev site via the one
    # that's not allowlisted makes every API call fail with "Failed to fetch".
    allowed_origins = [
        o.strip() for o in os.environ.get(
            "ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
        ).split(",")
        if o.strip()
    ]
    CORS(app, resources={r"/*": {"origins": allowed_origins, "expose_headers": ["X-Engine-Used"]}}, supports_credentials=True)

    return app


app = create_app()
print(app.url_map)

# ✅ SharedArrayBuffer Compatibility
# @app.after_request
# def add_security_headers(response):
#     response.headers["Cross-Origin-Opener-Policy"] = "cross-origin"
#     response.headers["Access-Control-Allow-Origin"] = "http://localhost:5173"
#     response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
#     return response

def find_watch_files():
    watch_dirs = ['api', 'models', 'services']
    base_path = os.path.dirname(__file__)
    all_files = []
    for d in watch_dirs:
        dir_path = os.path.join(base_path, d)
        for root, _, files in os.walk(dir_path):
            for f in files:
                if f.endswith('.py'):
                    all_files.append(os.path.join(root, f))
    return all_files

if __name__ == "__main__":
    use_ssl = os.environ.get("USE_SSL", "false").lower() == "true"
    ssl_context = ("../certs/localhost-cert.pem", "../certs/localhost-key.pem") if use_ssl else None
    run_simple(
        hostname="0.0.0.0",
        port=5001,
        application=app,
        use_debugger=True,
        use_reloader=True,
        extra_files=find_watch_files(),
        ssl_context=ssl_context,
        # One request must never block the rest: a first-time 3D mesh bake or
        # HuggingFace download can run for minutes, and without threading the
        # single dev worker starves every other request (CT slices, the AI,
        # the mesh fetch itself) until the browser gives up with
        # "Failed to fetch". Production (gunicorn gthread) is already threaded.
        threaded=True,
    )
