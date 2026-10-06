import pytest
from fastapi.testclient import TestClient
import backend.main as bm

bm.genai_client = None  # Test in clean offline/deterministic fallback mode
client = TestClient(bm.app)

def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "healthy"
    assert data["service"] == "alert-disaster-field-estimator"

def test_audit_post_1978():
    payload = {
        "address": "1813 Capistrano Ave, Wasco, CA",
        "year_built": 2020,
        "has_crawl_space": False,
        "area": "Kitchen",
        "is_after_hours": True,
        "transcript": "Extech meter 99.9% SAT in toe kick"
    }
    res = client.post("/api/audit", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["adr_estimate"]["property_address"] == "1813 Capistrano Ave, Wasco, CA"
    assert data["adr_estimate"]["lead_notice_required"] is False
    assert "no lead or asbestos testing is required" in data["adr_estimate"]["findings_html"]
    assert "recommendations_html" in data["adr_estimate"]
    assert data["adr_estimate"]["proposed_cost"] == 2499

    # Verify line items have both full and short property names
    for item in data["xactimate_scope"]:
        assert item["code"]
        assert "description" in item and "desc" in item
        assert item["description"] == item["desc"]
        assert "quantity" in item and "qty" in item
        assert item["quantity"] == item["qty"]
        assert "unit_price" in item and "price" in item
        assert item["unit_price"] == item["price"]
        assert "waste_percent" in item and "waste" in item
        assert item["waste_percent"] == item["waste"]
        assert isinstance(item["total"], (int, float))

    assert "iicrc_defense_letter" in data
    assert "Matthew Myers" in data["iicrc_defense_letter"]
    assert "950983" in data["iicrc_defense_letter"]

def test_audit_pre_1978():
    payload = {
        "address": "404 18th St, Bakersfield, CA",
        "year_built": 1968,
        "has_crawl_space": True,
        "area": "Bathroom",
        "is_after_hours": False,
        "transcript": "Subfloor wet under clawfoot tub"
    }
    res = client.post("/api/audit", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["adr_estimate"]["lead_notice_required"] is True
    assert "California State Law requires third-party lead and asbestos testing" in data["adr_estimate"]["findings_html"]
    assert "(This does not include the pretest for lead/asbestos)" in data["adr_estimate"]["findings_html"]

def test_authorize_endpoint():
    payload = {
        "address": "1813 Capistrano Ave, Wasco, CA",
        "proposed_cost": 2499.0,
        "signature_png": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "photos_count": 3,
        "photos": [{"id": 1, "meter_type": "Extech MO290", "ocr_value": "99.9% SAT"}]
    }
    res = client.post("/api/authorize", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert "ADR-AUTH-" in data["auth_id"]
    assert data["contractor_license"] == "950983"
    assert data["estimator"] == "Matthew Myers"
    assert data["proposed_cost"] == 2499.0

def test_ocr_meter_fallback():
    res = client.post("/api/ocr-meter", json={"photo_base64": "data:image/jpeg;base64,fake"})
    assert res.status_code == 200
    data = res.json()
    assert data["meter_detected"] is True
    assert data["meter_type"] == "Extech MO290"
    assert "99.9% SAT" in data["value"]

def test_authorize_with_string_findings_and_recs():
    payload = {
        "address": "500 Oak St, Bakersfield, CA",
        "proposed_cost": 1999.0,
        "signature_png": "data:image/png;base64,sample",
        "findings": "<p>Saturated subfloor under kitchen island</p>",
        "recommendations": "4-ft flood cuts on north wall"
    }
    res = client.post("/api/authorize", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["proposed_cost"] == 1999.0

def test_normalize_xactimate_robustness():
    items = [
        {"code": "WTRDRY", "description": None, "desc": "Drywall demo", "quantity": "", "qty": 4, "unit_price": None, "price": 10.0, "waste": 5},
        {"code": None, "desc": None, "qty": "3", "price": "145.50"}
    ]
    normalized = bm.normalize_xactimate_items(items)
    assert len(normalized) == 2
    assert normalized[0]["description"] == "Drywall demo"
    assert normalized[0]["quantity"] == 4.0
    assert normalized[0]["unit_price"] == 10.0
    assert normalized[0]["waste_percent"] == 5.0
    assert normalized[0]["total"] == 42.0

    assert normalized[1]["code"] == "MISC"
    assert normalized[1]["description"] == "Remediation item"
    assert normalized[1]["quantity"] == 3.0
    assert normalized[1]["unit_price"] == 145.50

def test_parse_json_from_llm():
    raw_markdown = """```json
    {
      "meter_detected": true,
      "meter_type": "FLIR Thermal Camera",
      "value": "-8.4°F Delta T"
    }
    ```"""
    parsed = bm.parse_json_from_llm(raw_markdown)
    assert parsed["meter_detected"] is True
    assert parsed["meter_type"] == "FLIR Thermal Camera"

