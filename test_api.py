import os
import unittest

from backend.app import create_app, db, Product, Order, StoreSetting


class StoreApiTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app({
            "TESTING": True,
            "SQLALCHEMY_DATABASE_URI": "sqlite://",
            "ADMIN_API_KEY": "test-admin-secret",
        })
        self.client = self.app.test_client()
        with self.app.app_context():
            db.drop_all()
            db.create_all()
            db.session.add(StoreSetting(key="shipping_fee", value="5000"))
            db.session.add(Product(
                id="m-test0001", title="ملزمة اختبار", subject="الرياضيات",
                grade="sixth", branch="scientific", kind="original", price=7000,
                description="منتج اختبار آلي", available=True,
            ))
            db.session.commit()

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()

    def test_health(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["ok"])

    def test_products_public(self):
        response = self.client.get("/api/products")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["count"], 1)
        self.assertEqual(response.json["products"][0]["price"], 7000)

    def test_admin_protected(self):
        self.assertEqual(self.client.get("/api/admin/products").status_code, 401)
        response = self.client.get("/api/admin/products", headers={"Authorization": "Bearer test-admin-secret"})
        self.assertEqual(response.status_code, 200)

    def test_order_uses_server_price_and_shipping(self):
        response = self.client.post("/api/orders", json={
            "customer_name": "طالب اختبار", "customer_phone": "07812345678",
            "province": "كركوك", "address": "حي الاختبار قرب المدرسة",
            "payment_method": "cod", "items": [{"id": "m-test0001", "quantity": 2, "price": 1}],
        })
        self.assertEqual(response.status_code, 201, response.json)
        order = response.json["order"]
        self.assertEqual(order["subtotal"], 14000)
        self.assertEqual(order["shippingFee"], 5000)
        self.assertEqual(order["total"], 19000)
        self.assertEqual(order["paymentStatus"], "cod_due")
        self.assertTrue(order["orderCode"].startswith("SHAM-"))

    def test_reject_invalid_province(self):
        response = self.client.post("/api/orders", json={
            "customer_name": "طالب اختبار", "customer_phone": "07812345678",
            "province": "مدينة غير عراقية", "address": "حي الاختبار قرب المدرسة",
            "payment_method": "cod", "items": [{"id": "m-test0001", "quantity": 1}],
        })
        self.assertEqual(response.status_code, 400)

    def test_product_admin_create_and_update(self):
        headers = {"Authorization": "Bearer test-admin-secret"}
        created = self.client.post("/api/admin/products", headers=headers, json={
            "title": "ملزمة جديدة", "subject": "الكيمياء", "grade": "fifth",
            "branch": "scientific", "kind": "copy", "price": 4500,
            "description": "ملزمة اختبار ثانية", "available": True,
        })
        self.assertEqual(created.status_code, 201, created.json)
        product_id = created.json["product"]["id"]
        updated = self.client.patch(f"/api/admin/products/{product_id}", headers=headers, json={"price": 5500})
        self.assertEqual(updated.status_code, 200, updated.json)
        self.assertEqual(updated.json["product"]["price"], 5500)


if __name__ == "__main__":
    unittest.main(verbosity=2)
