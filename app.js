(() => {
  "use strict";

  const CONFIG = window.SHAM_CONFIG || {};
  const API_BASE = String(CONFIG.apiBaseUrl || "").trim().replace(/\/$/, "");
  const STORAGE_KEYS = { cart: "shamLibraryCart.v2", favorites: "shamLibraryFavorites.v2", products: "shamLibraryProducts.v1" };
  const DEFAULT_SHIPPING = Number(CONFIG.shippingFee) || 5000;
  const GRADE_LABELS = {
    sixth: "السادس الإعدادي", fifth: "الخامس الإعدادي", fourth: "الرابع الإعدادي", third_intermediate: "الثالث المتوسط"
  };
  const BRANCH_LABELS = { scientific: "العلمي", literary: "الأدبي", vocational: "المهني", general: "عام" };
  const COVER_BY_SUBJECT = { "الكيمياء": "chemistry", "الفيزياء": "physics", "الأحياء": "biology", "الرياضيات": "math", "اللغة العربية": "arabic", "العربية": "arabic", "اللغة الإنكليزية": "english", "الإنكليزية": "english" };
  const PROVINCES = ["بغداد", "نينوى", "البصرة", "أربيل", "السليمانية", "دهوك", "حلبجة", "كركوك", "الأنبار", "ديالى", "صلاح الدين", "بابل", "كربلاء", "النجف", "القادسية", "المثنى", "ذي قار", "ميسان", "واسط"];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const grid = $("#productGrid");
  const emptyState = $("#emptyState");
  const searchInput = $("#catalogSearch");
  const sortSelect = $("#sortSelect");
  const resultsSummary = $("#resultsSummary");
  const cartDrawer = $("#cartDrawer");
  const drawerBackdrop = $("#drawerBackdrop");
  const modalBackdrop = $("#modalBackdrop");
  const checkoutModal = $("#checkoutModal");
  const productModal = $("#productModal");
  const toastRegion = $("#toastRegion");
  const cartItems = $("#cartItems");
  const cartEmpty = $("#cartEmpty");
  const drawerFooter = $("#drawerFooter");
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  let PRODUCTS = [];
  let selectedGrade = "all";
  let selectedBranch = "all";
  let selectedKind = "all";
  let shippingFee = DEFAULT_SHIPPING;
  let activeOverlay = null;
  let focusedBeforeOverlay = null;
  let dataSourceReady = false;
  let toastTimers = new WeakMap();

  function loadJSON(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key) || "null"); return value ?? fallback; }
    catch (_) { return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { showToast("تعذّر الحفظ على هذا الجهاز."); }
  }
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }
  function money(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return "— د.ع";
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount)} ${esc(CONFIG.currencyLabel || "د.ع")}`;
  }
  function resolveImage(product) {
    const value = product.imageUrl || product.image_url || "";
    if (!value) return "";
    try { return new URL(value, API_BASE || window.location.href).href; }
    catch (_) { return ""; }
  }
  function normalizeProduct(product) {
    const grade = product.grade || "sixth";
    const subject = product.subject || "ملزمة دراسية";
    return {
      ...product,
      id: String(product.id),
      price: Number(product.price) || 0,
      title: String(product.title || subject),
      subject,
      grade,
      gradeLabel: product.gradeLabel || product.grade_label || GRADE_LABELS[grade] || grade,
      branch: product.branch || "general",
      branchLabel: product.branchLabel || product.branch_label || BRANCH_LABELS[product.branch] || "عام",
      kind: product.kind === "original" ? "original" : "copy",
      summary: product.summary || product.description || "تفاصيل الملزمة متاحة عند تأكيد الطلب.",
      featured: Number(product.featured) || 0,
      imageUrl: resolveImage(product),
      available: product.available !== false
    };
  }

  let cart = loadJSON(STORAGE_KEYS.cart, {});
  if (!cart || typeof cart !== "object" || Array.isArray(cart)) cart = {};
  let favorites = loadJSON(STORAGE_KEYS.favorites, []);
  if (!Array.isArray(favorites)) favorites = [];

  function getProduct(id) { return PRODUCTS.find(p => p.id === String(id)); }
  function itemCount() { return Object.values(cart).reduce((n, quantity) => n + Number(quantity || 0), 0); }
  function subtotal() {
    return Object.entries(cart).reduce((sum, [id, quantity]) => {
      const product = getProduct(id);
      return sum + (product ? product.price * quantity : 0);
    }, 0);
  }
  function grandTotal() { return subtotal() + (itemCount() ? shippingFee : 0); }
  function kindLabel(kind) { return kind === "original" ? "أصلي" : "مستنسخ"; }
  function coverClass(product) { return `cover-${COVER_BY_SUBJECT[product.subject] || "chemistry"}`; }

  function bookMarkup(product) {
    const cover = coverClass(product);
    const subject = esc(product.subject || "ملزمة دراسية");
    const grade = esc(product.gradeLabel || "مرحلة دراسية");
    const symbolBySubject = { "الكيمياء": "✳", "الفيزياء": "∿", "الأحياء": "❋", "الرياضيات": "∑", "اللغة العربية": "ض", "اللغة الإنكليزية": "Aa" };
    const symbol = esc(product.symbol || symbolBySubject[product.subject] || "✳");
    return `<div class="product-book" aria-hidden="true"><div class="book-brandline"><span>مكتبة الشام</span><span>دراسي</span></div><div class="book-symbol"><span>${symbol}</span></div><div class="book-title"><small>${grade}</small>${subject}</div><div class="book-foot">SHAM LIBRARY / STUDY SERIES</div></div>`;
  }
  function renderCard(product) {
    const fav = favorites.includes(product.id);
    const image = product.imageUrl ? `<img class="product-image" src="${esc(product.imageUrl)}" alt="غلاف ${esc(product.title)}" loading="lazy" onerror="this.remove()">` : "";
    return `<article class="product-card ${coverClass(product)}" data-product-id="${esc(product.id)}">
      <div class="product-visual ${coverClass(product)}">
        ${image}
        <span class="product-kind ${product.kind === "original" ? "kind-original" : "kind-copy"}">${kindLabel(product.kind)}</span>
        <button class="favorite-button ${fav ? "is-favorite" : ""}" data-action="favorite" data-id="${esc(product.id)}" type="button" aria-label="${fav ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}" aria-pressed="${fav}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 5.8a5 5 0 0 0-7.1 0L12 7.1l-1.3-1.3a5 5 0 0 0-7.1 7.1l1.3 1.3L12 21l7.1-6.8 1.3-1.3a5 5 0 0 0 0-7.1Z"/></svg></button>
        ${image ? "" : bookMarkup(product)}
      </div>
      <div class="product-card-body"><div class="product-meta"><span class="grade-label">${esc(product.gradeLabel)}</span><span>${esc(product.subject)}</span></div>
        <h3>${esc(product.title)}</h3><p class="product-description">${esc(product.instructor ? `المدرس: ${product.instructor} — ` : "")}${esc(product.summary)}</p>
        <div class="product-card-bottom"><div class="product-price">${money(product.price)}</div><button type="button" class="add-to-cart" data-action="add" data-id="${esc(product.id)}" aria-label="إضافة ${esc(product.title)} إلى السلة" title="إضافة إلى السلة"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>
        <button type="button" class="view-details" data-action="details" data-id="${esc(product.id)}">تفاصيل الملزمة <span>←</span></button></div></article>`;
  }

  function filteredProducts() {
    const query = (searchInput?.value || "").trim().toLocaleLowerCase("ar");
    const products = PRODUCTS.filter(p => {
      const gradeMatch = selectedGrade === "all" || p.grade === selectedGrade;
      const branchMatch = selectedBranch === "all" || p.branch === selectedBranch;
      const kindMatch = selectedKind === "all" || p.kind === selectedKind;
      const content = [p.title, p.subject, p.gradeLabel, p.branchLabel, p.instructor, p.summary, kindLabel(p.kind)].join(" ").toLocaleLowerCase("ar");
      return gradeMatch && branchMatch && kindMatch && (!query || content.includes(query));
    });
    switch (sortSelect?.value) {
      case "price-asc": products.sort((a, b) => a.price - b.price); break;
      case "price-desc": products.sort((a, b) => b.price - a.price); break;
      case "name": products.sort((a, b) => a.title.localeCompare(b.title, "ar")); break;
      default: products.sort((a, b) => a.featured - b.featured);
    }
    return products;
  }
  function renderProducts() {
    if (!grid) return;
    const results = filteredProducts();
    grid.innerHTML = results.map(renderCard).join("");
    emptyState.hidden = results.length > 0;
    grid.hidden = results.length === 0;
    const emptyTitle = $("#emptyState h3");
    const emptyText = $("#emptyState p");
    const emptyReset = $("#emptyResetButton");
    if (PRODUCTS.length === 0) {
      if (emptyTitle) emptyTitle.textContent = !API_BASE ? "المتجر بانتظار الربط" : (dataSourceReady ? "قائمة الملازم قيد التجهيز" : "تعذّر تحميل الملازم");
      if (emptyText) emptyText.textContent = !API_BASE ? "قائمة الملازم تُدار من بوت تيليغرام، وسيتم عرضها بعد ربط قاعدة البيانات." : (dataSourceReady ? "ماكو ملازم مضافة حالياً. ستظهر المنتجات هنا عند إضافتها من إدارة المكتبة." : "جرّب تحديث الصفحة لاحقاً أو تواصل مع المكتبة عبر واتساب.");
      if (emptyReset) {
        emptyReset.hidden = !API_BASE || dataSourceReady;
        emptyReset.textContent = "إعادة المحاولة";
      }
    } else {
      if (emptyTitle) emptyTitle.textContent = "ما لقينا نتيجة مطابقة";
      if (emptyText) emptyText.textContent = "جرّب كلمة بحث ثانية أو غيّر الفلاتر حتى تكتشف خيارات أكثر.";
      if (emptyReset) { emptyReset.hidden = false; emptyReset.textContent = "عرض كل الملازم"; }
    }
    const query = (searchInput?.value || "").trim();
    const count = PRODUCTS.length;
    if (resultsSummary) {
      if (!dataSourceReady && !PRODUCTS.length) resultsSummary.innerHTML = "المتجر بانتظار ربط قائمة الملازم";
      else if (!count) resultsSummary.innerHTML = "ماكو ملازم مضافة حالياً — قائمة المكتبة قيد التجهيز";
      else if (query || selectedGrade !== "all" || selectedBranch !== "all" || selectedKind !== "all") resultsSummary.innerHTML = `النتائج المطابقة: <strong>${results.length}</strong> من ${count} ملزمة`;
      else resultsSummary.innerHTML = `نعرض لك <strong>${results.length}</strong> ملزمة متاحة`;
    }
    const countNode = $("#productCount");
    if (countNode) countNode.textContent = String(PRODUCTS.length).padStart(2, "0");
    const notice = $("#catalogNotice");
    if (notice) {
      if (!API_BASE) notice.innerHTML = `<span>ⓘ</span> الموقع جاهز للربط، لكن رابط API لم يُضبط بعد. للطلب تواصل مع المكتبة عبر <a href="https://wa.me/${esc(CONFIG.whatsappNumber || "964786618512")}" target="_blank" rel="noopener">واتساب</a>.`;
      else if (!dataSourceReady) notice.innerHTML = `<span>ⓘ</span> تعذّر الاتصال بقائمة المنتجات حالياً. جرّب التحديث لاحقاً أو تواصل مع المكتبة.`;
      else notice.innerHTML = `<span>ⓘ</span> الأسعار والتوفر تُحدّث من إدارة مكتبة الشام. أجور التوصيل لجميع المحافظات ${money(shippingFee)}.`;
    }
  }

  function updateCartSummary() {
    const count = itemCount();
    if ($("#cartCount")) {
      $("#cartCount").textContent = count > 99 ? "99+" : String(count);
      $("#cartCount").setAttribute("aria-label", `${count} قطع في السلة`);
    }
    if ($("#drawerItemCount")) $("#drawerItemCount").textContent = `(${count})`;
    if ($("#checkoutCount")) $("#checkoutCount").textContent = String(count);
    if ($("#cartSubtotal")) $("#cartSubtotal").textContent = money(subtotal());
    if ($("#cartShipping")) $("#cartShipping").textContent = money(count ? shippingFee : 0);
    if ($("#cartGrandTotal")) $("#cartGrandTotal").textContent = money(grandTotal());
    if ($("#checkoutSubtotal")) $("#checkoutSubtotal").textContent = money(subtotal());
    if ($("#checkoutShipping")) $("#checkoutShipping").textContent = money(count ? shippingFee : 0);
    if ($("#checkoutTotal")) $("#checkoutTotal").textContent = money(grandTotal());
  }
  function persistCart() { saveJSON(STORAGE_KEYS.cart, cart); renderCart(); renderProducts(); updateCartSummary(); }
  function renderCart() {
    const entries = Object.entries(cart).filter(([id, qty]) => getProduct(id) && qty > 0);
    const isEmpty = entries.length === 0;
    cartEmpty.hidden = !isEmpty;
    drawerFooter.hidden = isEmpty;
    cartItems.hidden = isEmpty;
    if (isEmpty) { cartItems.innerHTML = ""; updateCartSummary(); return; }
    cartItems.innerHTML = entries.map(([id, quantity]) => {
      const p = getProduct(id);
      return `<div class="cart-item" data-cart-id="${esc(id)}"><div class="cart-thumb ${coverClass(p)}" aria-hidden="true">${esc(p.subject.slice(0, 1) || "✳")}</div><div class="cart-item-info"><h3>${esc(p.title)}</h3><small>${kindLabel(p.kind)} · ${esc(p.gradeLabel)} · ${esc(p.branchLabel)}</small><div class="quantity-control" aria-label="تعديل الكمية"><button type="button" data-cart-action="decrease" data-id="${esc(id)}" aria-label="تقليل الكمية">−</button><span>${quantity}</span><button type="button" data-cart-action="increase" data-id="${esc(id)}" aria-label="زيادة الكمية">+</button></div></div><div><div class="cart-item-price">${money(p.price * quantity)}</div><button type="button" class="remove-item" data-cart-action="remove" data-id="${esc(id)}" aria-label="حذف ${esc(p.title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div></div>`;
    }).join("");
    updateCartSummary();
  }
  function addToCart(id) {
    const p = getProduct(id);
    if (!p || !p.available) { showToast("هذه الملزمة غير متوفرة حالياً."); return; }
    cart[id] = Math.min(99, (Number(cart[id]) || 0) + 1);
    persistCart(); showToast(`انضافت «${p.title}» إلى السلة.`);
  }
  function toggleFavorite(id) {
    if (favorites.includes(id)) { favorites = favorites.filter(value => value !== id); showToast("انحذفت من المفضلة."); }
    else { favorites.push(id); showToast("انضافت إلى المفضلة."); }
    saveJSON(STORAGE_KEYS.favorites, favorites); renderProducts();
  }
  function showToast(message) {
    if (!toastRegion) return;
    const toast = document.createElement("div"); toast.className = "toast";
    toast.innerHTML = `<span class="toast-symbol" aria-hidden="true">✓</span><span>${esc(message)}</span>`;
    toastRegion.appendChild(toast);
    const timer = window.setTimeout(() => { toast.classList.add("is-leaving"); window.setTimeout(() => toast.remove(), reduceMotion ? 1 : 230); }, 2700);
    toastTimers.set(toast, timer);
  }
  function closeMobileMenu() {
    const nav = $("#mainNav"), toggle = $("#mobileMenuToggle");
    nav?.classList.remove("is-open"); toggle?.setAttribute("aria-expanded", "false"); toggle?.setAttribute("aria-label", "فتح القائمة");
  }
  function bodyLock() { document.body.classList.toggle("no-scroll", Boolean(activeOverlay)); }
  function openCart() {
    closeMobileMenu(); closeCheckout(false); closeProductModal(false);
    focusedBeforeOverlay = document.activeElement; activeOverlay = "cart";
    drawerBackdrop.hidden = false; cartDrawer.classList.add("is-open"); cartDrawer.setAttribute("aria-hidden", "false"); cartDrawer.inert = false;
    bodyLock(); $("#closeCartButton").focus({ preventScroll: true });
  }
  function closeCart(restore = true) {
    if (!cartDrawer.classList.contains("is-open")) return;
    cartDrawer.classList.remove("is-open"); cartDrawer.setAttribute("aria-hidden", "true"); cartDrawer.inert = true; drawerBackdrop.hidden = true;
    if (activeOverlay === "cart") activeOverlay = null; bodyLock();
    if (restore && focusedBeforeOverlay?.focus) focusedBeforeOverlay.focus({ preventScroll: true });
  }
  function openCheckout() {
    if (!itemCount()) { showToast("أضف ملزمة واحدة على الأقل إلى السلة."); return; }
    closeCart(false); closeProductModal(false); focusedBeforeOverlay = $("#openCartButton"); activeOverlay = "checkout";
    modalBackdrop.hidden = false; checkoutModal.classList.add("is-open"); checkoutModal.setAttribute("aria-hidden", "false"); checkoutModal.inert = false;
    $("#checkoutStatus").hidden = true; $("#checkoutStatus").textContent = ""; updateCartSummary(); bodyLock();
    window.setTimeout(() => $("#customerName")?.focus({ preventScroll: true }), reduceMotion ? 0 : 120);
  }
  function closeCheckout(restore = true) {
    if (!checkoutModal.classList.contains("is-open")) return;
    checkoutModal.classList.remove("is-open"); checkoutModal.setAttribute("aria-hidden", "true"); checkoutModal.inert = true;
    if (activeOverlay === "checkout") activeOverlay = null;
    if (activeOverlay !== "product") modalBackdrop.hidden = true; bodyLock();
    if (restore && focusedBeforeOverlay?.focus) focusedBeforeOverlay.focus({ preventScroll: true });
  }
  function openProductDetails(id) {
    const p = getProduct(id); if (!p) return;
    closeCart(false); closeCheckout(false); focusedBeforeOverlay = document.activeElement; activeOverlay = "product";
    const image = p.imageUrl ? `<img class="detail-product-image" src="${esc(p.imageUrl)}" alt="غلاف ${esc(p.title)}">` : bookMarkup(p);
    $("#productModalContent").innerHTML = `<div class="detail-cover ${coverClass(p)}">${image}</div><div class="detail-copy"><span class="product-kind ${p.kind === "original" ? "kind-original" : "kind-copy"}">${kindLabel(p.kind)}</span><h2 id="productModalTitle">${esc(p.title)}</h2><p>${esc(p.summary)}</p><div class="detail-grade">${esc(p.gradeLabel)} · ${esc(p.branchLabel)} · ${esc(p.subject)}${p.instructor ? ` · المدرس: ${esc(p.instructor)}` : ""}</div><div class="detail-price-row"><strong>${money(p.price)}</strong><button type="button" class="button button-primary" data-action="add-from-details" data-id="${esc(p.id)}">أضف للسلة <span>＋</span></button></div></div>`;
    modalBackdrop.hidden = false; productModal.classList.add("is-open"); productModal.setAttribute("aria-hidden", "false"); productModal.inert = false;
    bodyLock(); $("#closeProductModalButton").focus({ preventScroll: true });
  }
  function closeProductModal(restore = true) {
    if (!productModal.classList.contains("is-open")) return;
    productModal.classList.remove("is-open"); productModal.setAttribute("aria-hidden", "true"); productModal.inert = true;
    if (activeOverlay === "product") activeOverlay = null; if (activeOverlay !== "checkout") modalBackdrop.hidden = true;
    bodyLock(); if (restore && focusedBeforeOverlay?.focus) focusedBeforeOverlay.focus({ preventScroll: true });
  }
  function resetFilters() {
    selectedGrade = selectedBranch = selectedKind = "all"; searchInput.value = ""; sortSelect.value = "featured";
    $$("#gradeFilters [data-grade]").forEach(b => b.classList.toggle("active", b.dataset.grade === "all"));
    $$("#branchFilters [data-branch]").forEach(b => b.classList.toggle("active", b.dataset.branch === "all"));
    $$("#typeFilters [data-kind]").forEach(b => b.classList.toggle("active", b.dataset.kind === "all")); renderProducts();
  }
  function setStatus(message, kind = "info", html = "") {
    const node = $("#checkoutStatus");
    node.hidden = false; node.className = `form-status status-${kind}`;
    node.innerHTML = `<span>${esc(message)}</span>${html}`;
  }
  function orderMessage(customer) {
    const lines = [
      `طلب جديد من موقع مكتبة الشام`, "--------------------", `الاسم: ${customer.name}`, `الهاتف: ${customer.phone}`,
      `المحافظة: ${customer.province}`, `العنوان: ${customer.address}`, "", "الملازم المطلوبة:"
    ];
    Object.entries(cart).forEach(([id, quantity]) => { const p = getProduct(id); if (p && quantity > 0) lines.push(`• ${p.title} — ${kindLabel(p.kind)} — الكمية: ${quantity} — ${money(p.price * quantity)}`); });
    lines.push("", `مجموع الملازم: ${money(subtotal())}`, `التوصيل: ${money(shippingFee)}`, `الإجمالي: ${money(grandTotal())}`, `طريقة الدفع: ${customer.payment === "cod" ? "الدفع عند التوصيل" : "ماستر كارد (بانتظار تأكيد المكتبة)"}`);
    if (customer.notes) lines.push("", `ملاحظة: ${customer.notes}`);
    return lines.join("\n");
  }
  function openWhatsAppFallback(customer, reason) {
    const msg = orderMessage(customer);
    const number = String(CONFIG.whatsappNumber || "964786618512").replace(/\D/g, "");
    const link = `https://wa.me/${number}?text=${encodeURIComponent(msg)}`;
    setStatus(`${reason} تم تجهيز الطلب كرسالة واتساب احتياطية؛ راجع الرسالة وأرسلها للمكتبة.`, "warning", ` <a class="status-link" href="${esc(link)}" target="_blank" rel="noopener">فتح واتساب بالطلب</a>`);
  }
  async function submitOrder(event) {
    event.preventDefault();
    if (!itemCount()) { setStatus("السلة فارغة. أضف الملزمة التي تحتاجها أولاً.", "error"); return; }
    const customer = {
      name: $("#customerName").value.trim(), phone: $("#customerPhone").value.trim(),
      province: $("#customerProvince").value, address: $("#customerAddress").value.trim(),
      payment: $("#paymentMethod").value, notes: $("#orderNotes").value.trim()
    };
    if (customer.name.length < 2 || customer.phone.replace(/\D/g, "").length < 7 || !PROVINCES.includes(customer.province) || customer.address.length < 5) {
      setStatus("تأكد من الاسم ورقم الهاتف والمحافظة والعنوان بالتفصيل.", "error"); return;
    }
    const btn = $(".submit-order-button"); btn.disabled = true; btn.dataset.original = btn.innerHTML; btn.textContent = "جاري إرسال الطلب…";
    const fallback = () => { openWhatsAppFallback(customer, "ما قدرنا نوصل إلى نظام الطلبات حالياً."); };
    if (!API_BASE) {
      fallback(); btn.disabled = false; btn.innerHTML = btn.dataset.original; return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/orders`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_name: customer.name, customer_phone: customer.phone, province: customer.province, address: customer.address, notes: customer.notes, payment_method: customer.payment, items: Object.entries(cart).map(([id, quantity]) => ({ id, quantity })) })
      });
      const body = await response.json().catch(() => ({}));
      if (response.status >= 500 || response.status === 0) { fallback(); return; }
      if (!response.ok || !body.ok) { setStatus(body.message || "ما تم إرسال الطلب. راجع بياناتك أو تواصل ويّا المكتبة.", "error"); return; }
      const code = body.order?.orderCode || "—";
      cart = {}; saveJSON(STORAGE_KEYS.cart, cart); renderCart(); renderProducts(); updateCartSummary();
      const paymentNote = customer.payment === "mastercard" ? " اختيار الماستر كارد لا يعني أن الدفع تم إلكترونياً؛ راح تؤكد المكتبة طريقة الدفع. لا ترسل بيانات بطاقتك داخل الموقع." : "";
      setStatus(`${body.message || "تم استلام طلبك."} رقم الطلب: ${code}.${paymentNote}`, "success", ` <a class="status-link" href="https://wa.me/${esc(CONFIG.whatsappNumber)}?text=${encodeURIComponent(`أستفسر عن طلبي ${code}`)}" target="_blank" rel="noopener">متابعة مع المكتبة عبر واتساب</a>`);
      showToast(`تم استلام الطلب ${code}`);
    } catch (error) {
      console.warn("Order API request failed", error);
      fallback();
    } finally {
      btn.disabled = false; btn.innerHTML = btn.dataset.original || "تجهيز الطلب ↗";
    }
  }

  async function loadCatalog() {
    const cached = loadJSON(STORAGE_KEYS.products, []);
    if (Array.isArray(cached) && cached.length) PRODUCTS = cached.map(normalizeProduct);
    renderProducts(); renderCart(); updateCartSummary();
    if (!API_BASE) { dataSourceReady = false; renderProducts(); return; }
    try {
      const [productsResponse, storeResponse] = await Promise.all([
        fetch(`${API_BASE}/api/products`, { headers: { Accept: "application/json" } }),
        fetch(`${API_BASE}/api/store`, { headers: { Accept: "application/json" } }).catch(() => null)
      ]);
      if (!productsResponse.ok) throw new Error(`Products API returned ${productsResponse.status}`);
      const payload = await productsResponse.json();
      if (!payload.ok || !Array.isArray(payload.products)) throw new Error("Invalid products payload");
      PRODUCTS = payload.products.map(normalizeProduct);
      dataSourceReady = true;
      saveJSON(STORAGE_KEYS.products, PRODUCTS.map(p => ({ ...p, imageUrl: p.imageUrl && p.imageUrl.startsWith(API_BASE) ? p.imageUrl.slice(API_BASE.length) : p.imageUrl })));
      const ids = new Set(PRODUCTS.map(p => p.id));
      cart = Object.fromEntries(Object.entries(cart).filter(([id, q]) => ids.has(id) && Number(q) > 0).map(([id, q]) => [id, Math.min(99, Math.floor(Number(q)))]));
      if (storeResponse?.ok) {
        const store = await storeResponse.json().catch(() => null);
        if (store?.ok && Number.isFinite(Number(store.shippingFee))) shippingFee = Number(store.shippingFee);
      }
      saveJSON(STORAGE_KEYS.cart, cart); renderProducts(); renderCart(); updateCartSummary();
    } catch (error) {
      console.warn("Could not load live product catalogue", error);
      dataSourceReady = false;
      if (!PRODUCTS.length) showToast("قائمة الملازم غير متاحة حالياً.");
      renderProducts(); renderCart(); updateCartSummary();
    }
  }

  // Initial view and event listeners
  $("#currentYear").textContent = String(new Date().getFullYear());
  renderProducts(); renderCart(); updateCartSummary();
  searchInput?.addEventListener("input", renderProducts);
  sortSelect?.addEventListener("change", renderProducts);
  $("#gradeFilters")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-grade]"); if (!button) return;
    selectedGrade = button.dataset.grade; $$("#gradeFilters [data-grade]").forEach(b => b.classList.toggle("active", b === button)); renderProducts();
  });
  $("#branchFilters")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-branch]"); if (!button) return;
    selectedBranch = button.dataset.branch; $$("#branchFilters [data-branch]").forEach(b => b.classList.toggle("active", b === button)); renderProducts();
  });
  $("#typeFilters")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-kind]"); if (!button) return;
    selectedKind = button.dataset.kind; $$("#typeFilters [data-kind]").forEach(b => b.classList.toggle("active", b === button)); renderProducts();
  });
  $("#clearFiltersButton")?.addEventListener("click", resetFilters);
  $("#emptyResetButton")?.addEventListener("click", () => {
    if (API_BASE && !dataSourceReady && PRODUCTS.length === 0) loadCatalog();
    else resetFilters();
  });
  $("#searchFocusButton")?.addEventListener("click", () => { $("#catalog").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" }); window.setTimeout(() => searchInput.focus({ preventScroll: true }), reduceMotion ? 0 : 350); });
  grid?.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]"); if (!button) return;
    const { action, id } = button.dataset;
    if (action === "add") addToCart(id); else if (action === "favorite") toggleFavorite(id); else if (action === "details") openProductDetails(id);
  });
  $("#productModalContent")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-action='add-from-details']"); if (!button) return;
    const id = button.dataset.id; closeProductModal(false); addToCart(id); openCart();
  });
  $("#openCartButton")?.addEventListener("click", openCart);
  $("#closeCartButton")?.addEventListener("click", () => closeCart());
  $("#browseFromCartButton")?.addEventListener("click", () => { closeCart(false); $("#catalog").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" }); });
  $("#continueShoppingButton")?.addEventListener("click", () => closeCart());
  drawerBackdrop?.addEventListener("click", () => closeCart());
  cartItems?.addEventListener("click", event => {
    const button = event.target.closest("button[data-cart-action]"); if (!button) return;
    const { cartAction, id } = button.dataset; if (!getProduct(id)) return;
    if (cartAction === "increase") cart[id] = Math.min(99, (Number(cart[id]) || 0) + 1);
    else if (cartAction === "decrease") { cart[id] = (Number(cart[id]) || 0) - 1; if (cart[id] < 1) delete cart[id]; }
    else if (cartAction === "remove") delete cart[id];
    persistCart();
  });
  $("#checkoutButton")?.addEventListener("click", openCheckout);
  $("#closeCheckoutButton")?.addEventListener("click", () => closeCheckout());
  $("#checkoutForm")?.addEventListener("submit", submitOrder);
  $("#closeProductModalButton")?.addEventListener("click", () => closeProductModal());
  modalBackdrop?.addEventListener("click", () => { if (activeOverlay === "checkout") closeCheckout(); else if (activeOverlay === "product") closeProductModal(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { if (activeOverlay === "checkout") closeCheckout(); else if (activeOverlay === "product") closeProductModal(); else if (activeOverlay === "cart") closeCart(); closeMobileMenu(); }
  });
  const mobileToggle = $("#mobileMenuToggle"), mainNav = $("#mainNav");
  mobileToggle?.addEventListener("click", () => {
    const open = !mainNav.classList.contains("is-open"); mainNav.classList.toggle("is-open", open);
    mobileToggle.setAttribute("aria-expanded", String(open)); mobileToggle.setAttribute("aria-label", open ? "إغلاق القائمة" : "فتح القائمة");
  });
  $$(".main-nav a").forEach(link => link.addEventListener("click", closeMobileMenu));
  loadCatalog();
})();
