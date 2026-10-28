from __future__ import annotations

import base64
import hmac
import io
import json
import logging
import os
import re
import secrets
from datetime import datetime, timezone
from typing import Any

import requests
from flask import Flask, current_app, jsonify, request, send_file
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import func, text
from sqlalchemy.exc import SQLAlchemyError

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("sham-library")


db = SQLAlchemy()

GRADES = {
    "sixth": "السادس الإعدادي",
    "fifth": "الخامس الإعدادي",
    "fourth": "الرابع الإعدادي",
    "third_intermediate": "الثالث المتوسط",
}
BRANCHES = {
    "scientific": "العلمي",
    "literary": "الأدبي",
    "vocational": "المهني",
    "general": "عام",
}
KINDS = {"original": "أصلية", "copy": "مستنسخة"}
ORDER_STATUSES = {
    "new": "جديد",
    "confirmed": "تم التأكيد",
    "preparing": "قيد التجهيز",
    "shipped": "تم الشحن",
    "delivered": "تم التسليم",
    "cancelled": "ملغي",
}
PAYMENT_STATUSES = {
    "pending": "بانتظار الدفع",
    "awaiting_manual_confirmation": "بانتظار تأكيد المكتبة",
    "paid": "مدفوع",
    "cod_due": "الدفع عند التوصيل",
}
IRAQI_PROVINCES = {
    "بغداد", "نينوى", "البصرة", "أربيل", "السليمانية", "دهوك", "حلبجة", "كركوك",
    "الأنبار", "ديالى", "صلاح الدين", "بابل", "كربلاء", "النجف", "القادسية",
    "المثنى", "ذي قار", "ميسان", "واسط",
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def normalise_database_url(url: str) -> str:
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    if url.startswith("postgresql://") and "+psycopg" not in url:
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


class Product(db.Model):
    id = db.Column(db.String(24), primary_key=True)
    title = db.Column(db.String(180), nullable=False)
    subject = db.Column(db.String(100), nullable=False)
    grade = db.Column(db.String(40), nullable=False)
    branch = db.Column(db.String(40), nullable=False, default="general")
    kind = db.Column(db.String(20), nullable=False)
    price = db.Column(db.Integer, nullable=False)
    instructor = db.Column(db.String(120), nullable=False, default="")
    description = db.Column(db.String(800), nullable=False, default="")
    available = db.Column(db.Boolean, nullable=False, default=True)
    featured = db.Column(db.Integer, nullable=False, default=0)
    image_url = db.Column(db.String(1000), nullable=False, default="")
    image_data = db.Column(db.LargeBinary, nullable=True)
    image_mime = db.Column(db.String(100), nullable=False, default="image/jpeg")
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=utcnow, onupdate=utcnow)

    def public_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "subject": self.subject,
            "grade": self.grade,
            "gradeLabel": GRADES.get(self.grade, self.grade),
            "branch": self.branch,
            "branchLabel": BRANCHES.get(self.branch, self.branch),
            "kind": self.kind,
            "kindLabel": KINDS.get(self.kind, self.kind),
            "price": self.price,
            "instructor": self.instructor or "",
            "description": self.description or "",
            "summary": self.description or "",
            "available": bool(self.available),
            "featured": self.featured,
            "imageUrl": f"/api/products/{self.id}/image" if self.image_data else (self.image_url or ""),
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }

    def admin_dict(self) -> dict[str, Any]:
        data = self.public_dict()
        data["hasImage"] = bool(self.image_data or self.image_url)
        return data


class StoreSetting(db.Model):
    key = db.Column(db.String(80), primary_key=True)
    value = db.Column(db.String(500), nullable=False)
    updated_at = db.Column(db.DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class Order(db.Model):
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    order_code = db.Column(db.String(40), unique=True, nullable=True)
    customer_name = db.Column(db.String(100), nullable=False)
    customer_phone = db.Column(db.String(30), nullable=False)
    province = db.Column(db.String(60), nullable=False)
    address = db.Column(db.String(400), nullable=False)
    notes = db.Column(db.String(700), nullable=False, default="")
    items_json = db.Column(db.Text, nullable=False)
    subtotal = db.Column(db.Integer, nullable=False)
    shipping_fee = db.Column(db.Integer, nullable=False, default=5000)
    total = db.Column(db.Integer, nullable=False)
    payment_method = db.Column(db.String(30), nullable=False)
    payment_status = db.Column(db.String(50), nullable=False)
    status = db.Column(db.String(30), nullable=False, default="new")
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=utcnow, onupdate=utcnow)

    @property
    def items(self) -> list[dict[str, Any]]:
        try:
            return json.loads(self.items_json)
        except (TypeError, json.JSONDecodeError):
            return []

    def public_dict(self) -> dict[str, Any]:
        return {
            "orderCode": self.order_code or f"SHAM-{self.id:06d}",
            "customerName": self.customer_name,
            "customerPhone": self.customer_phone,
            "province": self.province,
            "address": self.address,
            "notes": self.notes,
            "items": self.items,
            "subtotal": self.subtotal,
            "shippingFee": self.shipping_fee,
            "total": self.total,
            "paymentMethod": self.payment_method,
            "paymentStatus": self.payment_status,
            "status": self.status,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
        }


# ---------- Settings and auth ----------
def get_setting(key: str, default: str) -> str:
    item = db.session.get(StoreSetting, key)
    return item.value if item else default


def set_setting(key: str, value: str) -> None:
    item = db.session.get(StoreSetting, key)
    if item:
        item.value = str(value)
    else:
        db.session.add(StoreSetting(key=key, value=str(value)))
    db.session.commit()


def shipping_fee() -> int:
    try:
        return max(0, min(100000, int(get_setting("shipping_fee", "5000"))))
    except ValueError:
        return 5000


def admin_authorised() -> bool:
    expected = str(current_app.config.get("ADMIN_API_KEY") or os.getenv("ADMIN_API_KEY", "")).strip()
    supplied = request.headers.get("Authorization", "")
    if supplied.lower().startswith("bearer "):
        supplied = supplied[7:].strip()
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))


def admin_required(fn):
    from functools import wraps

    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not admin_authorised():
            return jsonify({"ok": False, "error": "unauthorised", "message": "Missing or invalid admin API key."}), 401
        return fn(*args, **kwargs)
    return wrapped


def json_error(message: str, status: int = 400, code: str = "invalid_request"):
    return jsonify({"ok": False, "error": code, "message": message}), status


def normalise_slug(value: str, allowed: dict[str, str], aliases: dict[str, str] | None = None) -> str | None:
    value = (value or "").strip().lower().replace(" ", "_")
    if value in allowed:
        return value
    if aliases and value in aliases:
        return aliases[value]
    return None


def product_values(payload: dict[str, Any], existing: Product | None = None) -> tuple[dict[str, Any] | None, str | None]:
    aliases_grade = {
        "six": "sixth", "السادس": "sixth", "السادس_الاعدادي": "sixth", "السادس_الإعدادي": "sixth",
        "الخامس": "fifth", "الخامس_الاعدادي": "fifth", "الخامس_الإعدادي": "fifth",
        "الرابع": "fourth", "الرابع_الاعدادي": "fourth", "الرابع_الإعدادي": "fourth",
        "الثالث_المتوسط": "third_intermediate", "الثالث": "third_intermediate", "ثالث_متوسط": "third_intermediate",
    }
    aliases_branch = {"علمي": "scientific", "العلمي": "scientific", "ادبي": "literary", "أدبي": "literary", "الادبي": "literary", "الأدبي": "literary", "مهني": "vocational", "المهني": "vocational", "عام": "general"}
    aliases_kind = {"اصلي": "original", "أصلي": "original", "اصلية": "original", "أصلية": "original", "مستنسخ": "copy", "مستنسخة": "copy", "نسخ": "copy"}
    result: dict[str, Any] = {}
    for field, max_len in (("title", 180), ("subject", 100)):
        value = str(payload.get(field, getattr(existing, field, "")) or "").strip()
        if not value or len(value) > max_len:
            return None, f"{field} is required and must be at most {max_len} characters."
        result[field] = value
    grade_raw = str(payload.get("grade", getattr(existing, "grade", "")) or "").strip()
    grade = normalise_slug(grade_raw, GRADES, aliases_grade)
    if grade not in GRADES:
        return None, "grade must be sixth, fifth, fourth, or third_intermediate."
    result["grade"] = grade
    branch_raw = str(payload.get("branch", getattr(existing, "branch", "general")) or "general").strip()
    branch = normalise_slug(branch_raw, BRANCHES, aliases_branch)
    if branch not in BRANCHES:
        return None, "branch must be scientific, literary, vocational, or general."
    result["branch"] = branch
    kind_raw = str(payload.get("kind", getattr(existing, "kind", "")) or "").strip()
    kind = normalise_slug(kind_raw, KINDS, aliases_kind)
    if kind not in KINDS:
        return None, "kind must be original or copy."
    result["kind"] = kind
    try:
        price = int(payload.get("price", getattr(existing, "price", 0)))
    except (TypeError, ValueError):
        return None, "price must be an integer in IQD."
    if price < 0 or price > 100_000_000:
        return None, "price is outside the allowed range."
    result["price"] = price
    instructor = str(payload.get("instructor", getattr(existing, "instructor", "")) or "").strip()
    description = str(payload.get("description", payload.get("summary", getattr(existing, "description", ""))) or "").strip()
    if len(instructor) > 120 or len(description) > 800:
        return None, "instructor or description is too long."
    result["instructor"] = instructor
    result["description"] = description
    result["available"] = parse_bool(payload.get("available", getattr(existing, "available", True)))
    try:
        result["featured"] = int(payload.get("featured", getattr(existing, "featured", 0)) or 0)
    except (TypeError, ValueError):
        result["featured"] = 0
    image_url = str(payload.get("image_url", getattr(existing, "image_url", "")) or "").strip()
    if image_url and (not image_url.startswith("https://") or len(image_url) > 1000):
        return None, "image_url must be an https URL (or empty)."
    result["image_url"] = image_url
    if payload.get("image_base64"):
        try:
            raw = base64.b64decode(str(payload["image_base64"]), validate=True)
        except (ValueError, base64.binascii.Error):
            return None, "image_base64 is invalid."
        if len(raw) > 2_000_000:
            return None, "Image is too large (maximum 2 MB)."
        mime = str(payload.get("image_mime", "image/jpeg"))
        if mime not in {"image/jpeg", "image/png", "image/webp"}:
            return None, "Image must be JPEG, PNG, or WebP."
        result["image_data"] = raw
        result["image_mime"] = mime
    elif existing is None:
        result["image_data"] = None
        result["image_mime"] = "image/jpeg"
    return result, None


def parse_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() not in {"false", "0", "no", "off", "متوقف", "غير متوفر"}


def new_product(payload: dict[str, Any]) -> tuple[Product | None, str | None]:
    values, error = product_values(payload)
    if error:
        return None, error
    values["id"] = "m-" + secrets.token_hex(4)
    product = Product(**values)
    db.session.add(product)
    return product, None


def create_app(test_config: dict[str, Any] | None = None) -> Flask:
    app = Flask(__name__)
    database_url = normalise_database_url(os.getenv("DATABASE_URL", "sqlite:///sham_library.db"))
    app.config.update(
        SQLALCHEMY_DATABASE_URI=database_url,
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        MAX_CONTENT_LENGTH=3 * 1024 * 1024,
        JSON_SORT_KEYS=False,
        ADMIN_API_KEY=os.getenv("ADMIN_API_KEY", ""),
    )
    if test_config:
        app.config.update(test_config)
    db.init_app(app)

    @app.after_request
    def add_cors_headers(response):
        origin = request.headers.get("Origin", "")
        allowed = [x.strip() for x in os.getenv("ALLOWED_ORIGINS", "*").split(",") if x.strip()]
        if "*" in allowed:
            response.headers["Access-Control-Allow-Origin"] = "*"
        elif origin and origin in allowed:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Telegram-Bot-Api-Secret-Token"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    with app.app_context():
        db.create_all()
        if db.session.get(StoreSetting, "shipping_fee") is None:
            db.session.add(StoreSetting(key="shipping_fee", value="5000"))
            db.session.commit()

    @app.get("/")
    def api_root():
        return jsonify({"ok": True, "service": "maktabat-alsham-api", "health": "/api/health"})

    @app.get("/api/health")
    def health():
        try:
            db.session.execute(text("SELECT 1"))
            return jsonify({"ok": True, "service": "maktabat-alsham-api", "database": "connected"})
        except SQLAlchemyError:
            log.exception("Health database check failed")
            return jsonify({"ok": False, "service": "maktabat-alsham-api", "database": "error"}), 503

    @app.get("/api/store")
    def store_info():
        return jsonify({
            "ok": True,
            "storeName": "مكتبة الشام",
            "shippingFee": shipping_fee(),
            "currency": "IQD",
            "paymentMethods": ["cod", "mastercard"],
            "whatsapp": "964786618512",
            "telegram": "https://t.me/sham1lib",
        })

    @app.get("/api/products")
    def list_products():
        include_unavailable = request.args.get("include_unavailable") == "1" and admin_authorised()
        query = Product.query
        if not include_unavailable:
            query = query.filter_by(available=True)
        grade = request.args.get("grade")
        branch = request.args.get("branch")
        kind = request.args.get("kind")
        if grade in GRADES:
            query = query.filter_by(grade=grade)
        if branch in BRANCHES:
            query = query.filter_by(branch=branch)
        if kind in KINDS:
            query = query.filter_by(kind=kind)
        products = query.order_by(Product.featured.asc(), Product.created_at.desc()).all()
        return jsonify({"ok": True, "products": [p.public_dict() for p in products], "count": len(products)})

    @app.get("/api/products/<product_id>/image")
    def product_image(product_id: str):
        product = db.session.get(Product, product_id)
        if not product or not product.image_data:
            return json_error("image_not_found", 404, "not_found")
        return send_file(io.BytesIO(product.image_data), mimetype=product.image_mime, max_age=3600, download_name=f"{product.id}.image")

    @app.post("/api/orders")
    def create_order():
        payload = request.get_json(silent=True) or {}
        if payload.get("website"):
            return jsonify({"ok": True, "message": "accepted"}), 202
        name = str(payload.get("customer_name", "")).strip()
        phone = str(payload.get("customer_phone", "")).strip()
        province = str(payload.get("province", "")).strip()
        address = str(payload.get("address", "")).strip()
        notes = str(payload.get("notes", "")).strip()
        payment_method = str(payload.get("payment_method", "cod")).strip().lower()
        if len(name) < 2 or len(name) > 100:
            return json_error("اكتب الاسم بصورة صحيحة.")
        if not 7 <= len(re.sub(r"\D", "", phone)) <= 16 or len(phone) > 30:
            return json_error("رقم الهاتف غير صحيح.")
        if province not in IRAQI_PROVINCES:
            return json_error("اختر محافظة عراقية من القائمة.")
        if len(address) < 5 or len(address) > 400:
            return json_error("اكتب العنوان بالتفصيل.")
        if len(notes) > 700:
            return json_error("الملاحظة طويلة جداً.")
        if payment_method not in {"cod", "mastercard"}:
            return json_error("طريقة الدفع غير مدعومة.")
        items = payload.get("items")
        if not isinstance(items, list) or not items or len(items) > 100:
            return json_error("السلة فارغة أو تحتوي على عناصر كثيرة.")
        clean_items: list[dict[str, Any]] = []
        subtotal = 0
        seen: set[str] = set()
        for item in items:
            if not isinstance(item, dict):
                return json_error("عنصر غير صالح في السلة.")
            pid = str(item.get("id", ""))[:24]
            if pid in seen:
                continue
            seen.add(pid)
            try:
                quantity = int(item.get("quantity", 0))
            except (TypeError, ValueError):
                return json_error("كمية غير صحيحة.")
            if quantity < 1 or quantity > 99:
                return json_error("الكمية يجب أن تكون بين 1 و99.")
            product = db.session.get(Product, pid)
            if not product or not product.available:
                return json_error("أحد المنتجات لم يعد متوفراً. حدّث قائمة الملازم.", 409, "product_unavailable")
            line_total = product.price * quantity
            subtotal += line_total
            clean_items.append({
                "id": product.id, "title": product.title, "subject": product.subject,
                "grade": GRADES.get(product.grade, product.grade),
                "branch": BRANCHES.get(product.branch, product.branch),
                "kind": KINDS.get(product.kind, product.kind),
                "unitPrice": product.price, "quantity": quantity, "lineTotal": line_total,
            })
        if not clean_items:
            return json_error("أضف منتجاً صالحاً للسلة.")
        fee = shipping_fee()
        order = Order(
            customer_name=name, customer_phone=phone, province=province, address=address,
            notes=notes, items_json=json.dumps(clean_items, ensure_ascii=False),
            subtotal=subtotal, shipping_fee=fee, total=subtotal + fee,
            payment_method=payment_method,
            payment_status="cod_due" if payment_method == "cod" else "awaiting_manual_confirmation",
            status="new",
        )
        try:
            db.session.add(order)
            db.session.flush()
            order.order_code = f"SHAM-{datetime.now().strftime('%y%m')}-{order.id:06d}"
            db.session.commit()
        except SQLAlchemyError:
            db.session.rollback()
            log.exception("Unable to save order")
            return json_error("تعذر حفظ الطلب حالياً. حاول مرة أخرى أو تواصل مع المكتبة.", 503, "database_error")
        notify_admins_new_order(order)
        return jsonify({
            "ok": True,
            "message": "تم استلام الطلب، وسيتواصل فريق المكتبة لتأكيده.",
            "order": order.public_dict(),
            "mastercardNotice": "طلب الماستر كارد بانتظار تأكيد المكتبة؛ لم يتم تحصيل مبلغ إلكتروني من خلال الموقع.",
        }), 201

    @app.get("/api/admin/products")
    @admin_required
    def admin_list_products():
        return jsonify({"ok": True, "products": [p.admin_dict() for p in Product.query.order_by(Product.created_at.desc()).all()]})

    @app.post("/api/admin/products")
    @admin_required
    def admin_create_product():
        payload = request.get_json(silent=True) or {}
        product, error = new_product(payload)
        if error:
            return json_error(error)
        try:
            db.session.commit()
        except SQLAlchemyError:
            db.session.rollback()
            log.exception("Unable to save product")
            return json_error("تعذر حفظ المنتج.", 500, "database_error")
        return jsonify({"ok": True, "product": product.admin_dict()}), 201

    @app.patch("/api/admin/products/<product_id>")
    @admin_required
    def admin_update_product(product_id: str):
        product = db.session.get(Product, product_id)
        if not product:
            return json_error("المنتج غير موجود.", 404, "not_found")
        payload = request.get_json(silent=True) or {}
        values, error = product_values(payload, product)
        if error:
            return json_error(error)
        for key, value in values.items():
            setattr(product, key, value)
        try:
            db.session.commit()
        except SQLAlchemyError:
            db.session.rollback()
            log.exception("Unable to update product")
            return json_error("تعذر تعديل المنتج.", 500, "database_error")
        return jsonify({"ok": True, "product": product.admin_dict()})

    @app.delete("/api/admin/products/<product_id>")
    @admin_required
    def admin_delete_product(product_id: str):
        product = db.session.get(Product, product_id)
        if not product:
            return json_error("المنتج غير موجود.", 404, "not_found")
        db.session.delete(product)
        db.session.commit()
        return jsonify({"ok": True, "deleted": product_id})

    @app.get("/api/admin/orders")
    @admin_required
    def admin_list_orders():
        status = request.args.get("status")
        query = Order.query
        if status in ORDER_STATUSES:
            query = query.filter_by(status=status)
        orders = query.order_by(Order.id.desc()).limit(100).all()
        return jsonify({"ok": True, "orders": [o.public_dict() for o in orders]})

    @app.patch("/api/admin/orders/<order_code>")
    @admin_required
    def admin_update_order(order_code: str):
        order = Order.query.filter_by(order_code=order_code).first()
        if not order:
            return json_error("الطلب غير موجود.", 404, "not_found")
        payload = request.get_json(silent=True) or {}
        if "status" in payload:
            if payload["status"] not in ORDER_STATUSES:
                return json_error("حالة الطلب غير صحيحة.")
            order.status = payload["status"]
        if "payment_status" in payload:
            if payload["payment_status"] not in PAYMENT_STATUSES:
                return json_error("حالة الدفع غير صحيحة.")
            order.payment_status = payload["payment_status"]
        db.session.commit()
        return jsonify({"ok": True, "order": order.public_dict()})

    @app.get("/api/admin/stats")
    @admin_required
    def admin_stats():
        total_products = Product.query.count()
        available_products = Product.query.filter_by(available=True).count()
        total_orders = Order.query.count()
        new_orders = Order.query.filter_by(status="new").count()
        delivered_revenue = db.session.query(func.coalesce(func.sum(Order.total), 0)).filter_by(status="delivered").scalar() or 0
        return jsonify({"ok": True, "stats": {
            "products": total_products,
            "availableProducts": available_products,
            "orders": total_orders,
            "newOrders": new_orders,
            "deliveredRevenue": int(delivered_revenue),
        }})

    @app.patch("/api/admin/settings/shipping")
    @admin_required
    def admin_update_shipping():
        payload = request.get_json(silent=True) or {}
        try:
            fee = int(payload.get("fee"))
        except (TypeError, ValueError):
            return json_error("اكتب مبلغاً صحيحاً.")
        if not 0 <= fee <= 100000:
            return json_error("مبلغ التوصيل خارج النطاق المسموح.")
        set_setting("shipping_fee", str(fee))
        return jsonify({"ok": True, "shippingFee": fee})

    @app.post("/api/admin/setup-webhook")
    @admin_required
    def admin_setup_webhook():
        success, message = configure_telegram_webhook()
        return jsonify({"ok": success, "message": message}), (200 if success else 400)

    @app.post("/api/telegram/webhook")
    def telegram_webhook():
        expected = os.getenv("TELEGRAM_WEBHOOK_SECRET", "").strip()
        supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "").strip()
        if not expected or not supplied or not hmac.compare_digest(expected, supplied):
            return jsonify({"ok": False}), 403
        update = request.get_json(silent=True) or {}
        try:
            process_telegram_update(update)
        except Exception:
            log.exception("Telegram update processing failed")
        return jsonify({"ok": True})

    @app.errorhandler(413)
    def request_too_large(_error):
        return json_error("الطلب أكبر من الحجم المسموح.", 413, "payload_too_large")

    @app.errorhandler(404)
    def not_found(_error):
        return json_error("المسار غير موجود.", 404, "not_found")

    @app.errorhandler(500)
    def server_error(_error):
        db.session.rollback()
        log.exception("Unhandled API error")
        return json_error("حدث خطأ داخلي. حاول لاحقاً.", 500, "internal_error")

    return app


# ---------- Telegram Bot API ----------
def telegram_token() -> str:
    return os.getenv("TELEGRAM_BOT_TOKEN", "").strip()


def telegram_call(method: str, payload: dict[str, Any], timeout: int = 10) -> dict[str, Any]:
    token = telegram_token()
    if not token:
        return {"ok": False, "description": "TELEGRAM_BOT_TOKEN is not configured"}
    try:
        response = requests.post(f"https://api.telegram.org/bot{token}/{method}", json=payload, timeout=timeout)
        data = response.json()
        if response.status_code >= 400:
            log.warning("Telegram API %s returned %s", method, response.status_code)
        return data if isinstance(data, dict) else {"ok": False, "description": "Unexpected Telegram response"}
    except (requests.RequestException, ValueError):
        log.exception("Telegram API request failed: %s", method)
        return {"ok": False, "description": "Telegram API connection failed"}


def configure_telegram_webhook() -> tuple[bool, str]:
    if not telegram_token():
        return False, "أضف TELEGRAM_BOT_TOKEN إلى متغيرات البيئة أولاً."
    secret = os.getenv("TELEGRAM_WEBHOOK_SECRET", "").strip()
    base_url = (os.getenv("PUBLIC_API_URL") or os.getenv("RENDER_EXTERNAL_URL") or "").strip().rstrip("/")
    if not secret or not base_url.startswith("https://"):
        return False, "اضبط TELEGRAM_WEBHOOK_SECRET وPUBLIC_API_URL (رابط HTTPS للـ API)."
    result = telegram_call("setWebhook", {
        "url": f"{base_url}/api/telegram/webhook",
        "secret_token": secret,
        "allowed_updates": ["message"],
        "drop_pending_updates": False,
    })
    if result.get("ok"):
        log.info("Telegram webhook configured: %s/api/telegram/webhook", base_url)
        return True, "تم ربط بوت تيليغرام بالـ API."
    return False, str(result.get("description", "فشل إعداد Webhook"))


def admin_ids() -> set[int]:
    result: set[int] = set()
    for raw in os.getenv("TELEGRAM_ADMIN_IDS", "").split(","):
        raw = raw.strip()
        if raw.isdigit():
            result.add(int(raw))
    return result


def send_telegram_message(chat_id: int | str, text: str, reply_markup: dict | None = None) -> None:
    payload: dict[str, Any] = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    telegram_call("sendMessage", payload)


def notify_admins_new_order(order: Order) -> None:
    ids = admin_ids()
    if not ids:
        log.warning("Order %s saved but TELEGRAM_ADMIN_IDS is empty; no notification sent", order.order_code)
        return
    item_lines = []
    for item in order.items:
        item_lines.append(f"• {html_escape(item['title'])} × {item['quantity']} — {format_iqd(item['lineTotal'])}")
    payment = "الدفع عند التوصيل" if order.payment_method == "cod" else "ماستر كارد — يحتاج تأكيداً يدوياً، لم يتم تحصيل مبلغ إلكتروني"
    text = (
        f"<b>🛍 طلب جديد من مكتبة الشام</b>\n"
        f"رقم الطلب: <code>{html_escape(order.order_code or '')}</code>\n"
        f"الاسم: {html_escape(order.customer_name)}\n"
        f"الهاتف: {html_escape(order.customer_phone)}\n"
        f"المحافظة: {html_escape(order.province)}\n"
        f"العنوان: {html_escape(order.address)}\n\n"
        f"<b>المنتجات</b>\n" + "\n".join(item_lines) + "\n\n"
        f"مجموع المنتجات: {format_iqd(order.subtotal)}\n"
        f"التوصيل: {format_iqd(order.shipping_fee)}\n"
        f"<b>الإجمالي: {format_iqd(order.total)}</b>\n"
        f"طريقة الدفع: {payment}\n"
        f"الحالة: جديد\n"
        + (f"ملاحظات: {html_escape(order.notes)}\n" if order.notes else "")
        + "\nللتحديث: <code>/order " + html_escape(order.order_code or "") + " confirmed</code>"
    )
    for chat_id in ids:
        send_telegram_message(chat_id, text)


def html_escape(value: Any) -> str:
    value = str(value if value is not None else "")
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def format_iqd(value: int) -> str:
    return f"{int(value):,} د.ع"


def get_telegram_photo(file_id: str) -> tuple[str | None, str | None]:
    token = telegram_token()
    if not token:
        return None, None
    try:
        result = requests.get(f"https://api.telegram.org/bot{token}/getFile", params={"file_id": file_id}, timeout=10).json()
        path = result.get("result", {}).get("file_path") if result.get("ok") else None
        if not path:
            return None, None
        response = requests.get(f"https://api.telegram.org/file/bot{token}/{path}", timeout=15)
        response.raise_for_status()
        data = response.content
        if not data or len(data) > 2_000_000:
            return None, None
        mime = response.headers.get("Content-Type", "image/jpeg").split(";")[0]
        if mime not in {"image/jpeg", "image/png", "image/webp"}:
            mime = "image/jpeg"
        return base64.b64encode(data).decode("ascii"), mime
    except requests.RequestException:
        log.exception("Could not download Telegram product image")
        return None, None


ADD_SESSIONS: dict[int, dict[str, Any]] = {}


def _help_text() -> str:
    return (
        "<b>إدارة مكتبة الشام</b>\n\n"
        "/whoami — عرض رقم حسابك\n"
        "/products — قائمة الملازم\n"
        "/add — إضافة ملزمة خطوة بخطوة\n"
        "/price ID PRICE — تعديل السعر\n"
        "/stock ID on|off — توفر الملزمة\n"
        "/edit ID FIELD VALUE — تعديل title أو subject أو description أو instructor أو branch أو grade أو kind\n"
        "/delete ID — حذف ملزمة\n"
        "/orders — آخر الطلبات\n"
        "/order CODE STATUS — تحديث الحالة\n"
        "/paid CODE — تعليم الطلب كمدفوع بعد التحقق يدوياً\n"
        "/shipping AMOUNT — تغيير أجور التوصيل\n"
        "/stats — إحصائيات المتجر\n"
        "/cancel — إلغاء عملية الإضافة\n\n"
        "الحالات: confirmed, preparing, shipped, delivered, cancelled.\n"
        "الصور تُرفع أثناء خطوات إضافة الملزمة، والحد الأقصى 2 ميغابايت."
    )


def process_telegram_update(update: dict[str, Any]) -> None:
    message = update.get("message") or update.get("edited_message")
    if not isinstance(message, dict):
        return
    chat = message.get("chat") or {}
    user = message.get("from") or {}
    chat_id = chat.get("id")
    user_id = user.get("id")
    if not chat_id or not user_id:
        return
    text = str(message.get("text", "")).strip()
    photos = message.get("photo") or []
    if text == "/whoami" or text.startswith("/whoami@"):
        send_telegram_message(chat_id, f"رقم حسابك في تيليغرام: <code>{user_id}</code>\nأضف هذا الرقم إلى TELEGRAM_ADMIN_IDS في إعدادات الاستضافة حتى تقدر تدير المتجر.")
        return
    if chat.get("type") != "private":
        send_telegram_message(chat_id, "لأمان الطلبات ومعلومات الزبائن، استخدم أوامر إدارة مكتبة الشام في المحادثة الخاصة مع البوت.")
        return
    if text.startswith("/start"):
        if user_id in admin_ids():
            send_telegram_message(chat_id, _help_text())
        else:
            send_telegram_message(chat_id, "أهلاً بك في بوت مكتبة الشام. هذا بوت إدارة خاص. إذا كنت صاحب المكتبة، أرسل /whoami ثم أضف رقمك إلى TELEGRAM_ADMIN_IDS في إعدادات الاستضافة.")
        return
    if user_id not in admin_ids():
        if text.startswith("/"):
            send_telegram_message(chat_id, "هذا البوت مخصص لإدارة المكتبة. إذا كنت المسؤول، أرسل /whoami ثم أضف رقمك إلى TELEGRAM_ADMIN_IDS في إعدادات الاستضافة.")
        return

    session = ADD_SESSIONS.get(int(user_id))
    if text.startswith("/cancel"):
        ADD_SESSIONS.pop(int(user_id), None)
        send_telegram_message(chat_id, "تم إلغاء عملية الإضافة.")
        return
    if text.startswith("/help"):
        send_telegram_message(chat_id, _help_text())
        return
    if text.startswith("/add"):
        ADD_SESSIONS[int(user_id)] = {"step": "title", "data": {}}
        send_telegram_message(chat_id, "إضافة ملزمة جديدة.\n1/7: أرسل اسم الملزمة كاملاً.\nيمكنك إلغاء العملية في أي وقت باستخدام /cancel")
        return

    if session:
        _handle_add_session(chat_id, int(user_id), message, session, text, photos)
        return

    command, _, tail = text.partition(" ")
    command = command.split("@", 1)[0].lower()
    args = tail.strip().split()
    with app.app_context():
        if command == "/products":
            products = Product.query.order_by(Product.created_at.desc()).limit(30).all()
            if not products:
                send_telegram_message(chat_id, "ماكو ملازم مضافة حالياً. استخدم /add لإضافة أول ملزمة.")
                return
            lines = [f"<code>{html_escape(p.id)}</code> — {html_escape(p.title)} — {format_iqd(p.price)} — {'متوفر' if p.available else 'نفد'}" for p in products]
            send_telegram_message(chat_id, "<b>قائمة الملازم</b>\n" + "\n".join(lines))
        elif command == "/price":
            if len(args) != 2 or not args[1].isdigit():
                send_telegram_message(chat_id, "الاستخدام: /price ID PRICE\nمثال: /price m-1234abcd 7500")
                return
            product = db.session.get(Product, args[0])
            if not product:
                send_telegram_message(chat_id, "ما لكيت هذه الملزمة. استخدم /products.")
                return
            product.price = int(args[1])
            db.session.commit()
            send_telegram_message(chat_id, f"تم تحديث سعر <b>{html_escape(product.title)}</b> إلى {format_iqd(product.price)}.")
        elif command == "/stock":
            if len(args) != 2 or args[1].lower() not in {"on", "off", "متوفر", "نفد"}:
                send_telegram_message(chat_id, "الاستخدام: /stock ID on أو /stock ID off")
                return
            product = db.session.get(Product, args[0])
            if not product:
                send_telegram_message(chat_id, "ما لكيت هذه الملزمة. استخدم /products.")
                return
            product.available = args[1].lower() in {"on", "متوفر"}
            db.session.commit()
            send_telegram_message(chat_id, f"تم تحديث التوفر: {html_escape(product.title)} — {'متوفر' if product.available else 'غير متوفر'}.")
        elif command == "/edit":
            if len(args) < 3:
                send_telegram_message(chat_id, "الاستخدام: /edit ID FIELD VALUE\nالحقول: title, subject, description, instructor, grade, branch, kind")
                return
            product = db.session.get(Product, args[0])
            if not product:
                send_telegram_message(chat_id, "الملزمة غير موجودة.")
                return
            field = args[1].lower()
            value = tail.split(None, 2)[2].strip()
            aliases = {"name": "title", "desc": "description", "teacher": "instructor"}
            field = aliases.get(field, field)
            if field not in {"title", "subject", "description", "instructor", "grade", "branch", "kind"}:
                send_telegram_message(chat_id, "هذا الحقل غير قابل للتعديل بهذا الأمر.")
                return
            # Construct the whole validated product while overriding only the requested field.
            payload = {k: getattr(product, k) for k in ("title", "subject", "grade", "branch", "kind", "price", "instructor", "description", "available", "featured", "image_url")}
            payload[field] = value
            values, error = product_values(payload, product)
            if error:
                send_telegram_message(chat_id, f"ما كدرت أعدّل الحقل: {html_escape(error)}")
                return
            for key, value_item in values.items():
                setattr(product, key, value_item)
            db.session.commit()
            send_telegram_message(chat_id, f"تم تحديث الملزمة <b>{html_escape(product.title)}</b>.")
        elif command == "/delete":
            if len(args) != 1:
                send_telegram_message(chat_id, "الاستخدام: /delete ID")
                return
            product = db.session.get(Product, args[0])
            if not product:
                send_telegram_message(chat_id, "الملزمة غير موجودة.")
                return
            title = product.title
            db.session.delete(product)
            db.session.commit()
            send_telegram_message(chat_id, f"تم حذف الملزمة: {html_escape(title)}.")
        elif command == "/orders":
            orders = Order.query.order_by(Order.id.desc()).limit(12).all()
            if not orders:
                send_telegram_message(chat_id, "ماكو طلبات لحد الآن.")
                return
            lines = []
            for order in orders:
                lines.append(f"<code>{html_escape(order.order_code or '')}</code> — {html_escape(order.customer_name)} — {format_iqd(order.total)} — {ORDER_STATUSES.get(order.status, order.status)}")
            send_telegram_message(chat_id, "<b>آخر الطلبات</b>\n" + "\n".join(lines))
        elif command == "/order":
            if len(args) != 2 or args[1] not in ORDER_STATUSES:
                send_telegram_message(chat_id, "الاستخدام: /order SHAM-YYMM-000001 confirmed\nالحالات: " + ", ".join(ORDER_STATUSES.keys()))
                return
            order = Order.query.filter_by(order_code=args[0]).first()
            if not order:
                send_telegram_message(chat_id, "الطلب غير موجود.")
                return
            order.status = args[1]
            db.session.commit()
            send_telegram_message(chat_id, f"تم تحديث الطلب <code>{html_escape(order.order_code)}</code> إلى: {ORDER_STATUSES[order.status]}.")
        elif command == "/paid":
            if len(args) != 1:
                send_telegram_message(chat_id, "الاستخدام: /paid ORDER_CODE — استخدمه فقط بعد التحقق الفعلي من الدفع.")
                return
            order = Order.query.filter_by(order_code=args[0]).first()
            if not order:
                send_telegram_message(chat_id, "الطلب غير موجود.")
                return
            order.payment_status = "paid"
            db.session.commit()
            send_telegram_message(chat_id, f"سُجل الطلب <code>{html_escape(order.order_code)}</code> كمدفوع. تأكد من الدفع قبل استخدام الأمر.")
        elif command == "/shipping":
            if len(args) != 1 or not args[0].isdigit() or not 0 <= int(args[0]) <= 100000:
                send_telegram_message(chat_id, "الاستخدام: /shipping 5000")
                return
            set_setting("shipping_fee", args[0])
            send_telegram_message(chat_id, f"تم تحديث أجور التوصيل إلى {format_iqd(int(args[0]))}.")
        elif command == "/stats":
            products = Product.query.count()
            available = Product.query.filter_by(available=True).count()
            orders = Order.query.count()
            new_orders = Order.query.filter_by(status="new").count()
            delivered = int(db.session.query(func.coalesce(func.sum(Order.total), 0)).filter_by(status="delivered").scalar() or 0)
            send_telegram_message(chat_id, f"<b>إحصائيات مكتبة الشام</b>\nعدد الملازم: {products}\nالمتوفرة: {available}\nالطلبات: {orders}\nالطلبات الجديدة: {new_orders}\nقيمة الطلبات المسلّمة: {format_iqd(delivered)}\nالتوصيل: {format_iqd(shipping_fee())}")
        elif command == "/setup":
            success, msg = configure_telegram_webhook()
            send_telegram_message(chat_id, html_escape(msg))
        elif command and command.startswith("/"):
            send_telegram_message(chat_id, "ما عرفت الأمر. استخدم /help.")


def _handle_add_session(chat_id: int, user_id: int, message: dict[str, Any], session: dict[str, Any], text: str, photos: list[dict[str, Any]]) -> None:
    data = session["data"]
    step = session["step"]
    if text.startswith("/") and text not in {"/skip"}:
        send_telegram_message(chat_id, "كمّل خطوات الإضافة أو استخدم /cancel للإلغاء.")
        return
    if step == "title":
        if len(text) < 2 or len(text) > 180:
            send_telegram_message(chat_id, "أرسل اسماً بين حرفين و180 حرفاً.")
            return
        data["title"] = text
        session["step"] = "subject"
        send_telegram_message(chat_id, "2/7: ما المادة؟ مثال: الكيمياء")
    elif step == "subject":
        if len(text) < 2 or len(text) > 100:
            send_telegram_message(chat_id, "أرسل اسم مادة صحيح.")
            return
        data["subject"] = text
        session["step"] = "grade"
        send_telegram_message(chat_id, "3/7: اختر المرحلة بإرسال كلمة واحدة: السادس أو الخامس أو الرابع أو الثالث المتوسط.")
    elif step == "grade":
        grade_aliases = {"السادس": "sixth", "السادس الإعدادي": "sixth", "السادس الاعدادي": "sixth", "الخامس": "fifth", "الخامس الإعدادي": "fifth", "الرابع": "fourth", "الرابع الإعدادي": "fourth", "الثالث": "third_intermediate", "الثالث المتوسط": "third_intermediate"}
        value = grade_aliases.get(text.strip(), text.strip().lower())
        if value not in GRADES:
            send_telegram_message(chat_id, "المرحلة غير صحيحة. أرسل: السادس، الخامس، الرابع، أو الثالث المتوسط.")
            return
        data["grade"] = value
        session["step"] = "branch"
        send_telegram_message(chat_id, "4/7: الفرع؟ أرسل: علمي أو أدبي أو مهني أو عام.")
    elif step == "branch":
        branch_aliases = {"علمي": "scientific", "العلمي": "scientific", "أدبي": "literary", "ادبي": "literary", "الأدبي": "literary", "مهني": "vocational", "المهني": "vocational", "عام": "general"}
        value = branch_aliases.get(text.strip(), text.strip().lower())
        if value not in BRANCHES:
            send_telegram_message(chat_id, "الفرع غير صحيح. أرسل: علمي أو أدبي أو مهني أو عام.")
            return
        data["branch"] = value
        session["step"] = "kind"
        send_telegram_message(chat_id, "5/7: نوع النسخة؟ أرسل: أصلية أو مستنسخة.")
    elif step == "kind":
        value = {"أصلية": "original", "أصلي": "original", "اصلية": "original", "مستنسخة": "copy", "مستنسخ": "copy"}.get(text.strip(), text.strip().lower())
        if value not in KINDS:
            send_telegram_message(chat_id, "النوع غير صحيح. أرسل أصلية أو مستنسخة.")
            return
        data["kind"] = value
        session["step"] = "price"
        send_telegram_message(chat_id, "6/7: أرسل السعر بالدينار العراقي كرقم فقط. مثال: 7500")
    elif step == "price":
        if not text.isdigit() or not 0 <= int(text) <= 100_000_000:
            send_telegram_message(chat_id, "السعر غير صحيح. أرسل رقماً بالدينار العراقي مثل 7500.")
            return
        data["price"] = int(text)
        session["step"] = "description"
        send_telegram_message(chat_id, "7/7: أرسل وصفاً قصيراً، أو اكتب - إذا ماكو وصف.")
    elif step == "description":
        data["description"] = "" if text == "-" else text[:800]
        session["step"] = "image"
        send_telegram_message(chat_id, "أرسل صورة غلاف الملزمة الآن، أو اكتب /skip بدون صورة. أقصى حجم 2 ميغابايت.")
    elif step == "image":
        if photos:
            largest = max(photos, key=lambda photo: int(photo.get("file_size", 0)))
            encoded, mime = get_telegram_photo(str(largest.get("file_id", "")))
            if not encoded:
                send_telegram_message(chat_id, "ما كدرت أحمل الصورة. جرّب صورة أصغر أو اكتب /skip.")
                return
            data["image_base64"] = encoded
            data["image_mime"] = mime or "image/jpeg"
            _finish_product_add(chat_id, user_id, data)
        elif text == "/skip":
            _finish_product_add(chat_id, user_id, data)
        elif text.startswith("https://"):
            data["image_url"] = text[:1000]
            _finish_product_add(chat_id, user_id, data)
        else:
            send_telegram_message(chat_id, "أرسل صورة، رابط صورة يبدأ بـ https://، أو /skip.")


def _finish_product_add(chat_id: int, user_id: int, data: dict[str, Any]) -> None:
    with app.app_context():
        product, error = new_product(data)
        if error or not product:
            send_telegram_message(chat_id, "تعذر إضافة الملزمة: " + html_escape(error or "خطأ غير معروف"))
            ADD_SESSIONS.pop(user_id, None)
            return
        try:
            db.session.commit()
            send_telegram_message(chat_id, f"✅ تمت إضافة الملزمة.\nالمعرّف: <code>{html_escape(product.id)}</code>\nالاسم: {html_escape(product.title)}\nالسعر: {format_iqd(product.price)}\nالمرحلة: {GRADES.get(product.grade, product.grade)}\nالفرع: {BRANCHES.get(product.branch, product.branch)}\n\nاستخدم /price أو /stock لتعديلها لاحقاً.")
        except SQLAlchemyError:
            db.session.rollback()
            log.exception("Failed to create product from Telegram wizard")
            send_telegram_message(chat_id, "تعذر حفظ الملزمة في قاعدة البيانات. جرّب مرة أخرى.")
        finally:
            ADD_SESSIONS.pop(user_id, None)


app = create_app()

# On Render (or another host) set these environment variables to enable automatic webhook setup.
if telegram_token() and os.getenv("TELEGRAM_WEBHOOK_SECRET", "").strip() and (os.getenv("PUBLIC_API_URL") or os.getenv("RENDER_EXTERNAL_URL")):
    try:
        with app.app_context():
            configured, result_message = configure_telegram_webhook()
            if not configured:
                log.warning("Telegram webhook setup did not complete: %s", result_message)
    except Exception:
        log.exception("Telegram webhook setup failed during startup")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=False)
