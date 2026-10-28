(() => {
  "use strict";

  const CONFIG = window.SHAM_CONFIG || { storeName: "مكتبة الشام", whatsappNumber: "", currencyLabel: "د.ع" };
  const PRODUCTS = Array.isArray(window.SHAM_PRODUCTS) ? window.SHAM_PRODUCTS : [];
  const VALID_GRADES = new Set(["sixth-science", "sixth-literary", "fifth", "fourth"]);
  const VALID_KINDS = new Set(["original", "copy"]);
  const COVER_NAMES = {
    chemistry: "الكيمياء", physics: "الفيزياء", biology: "الأحياء",
    math: "الرياضيات", arabic: "اللغة العربية", english: "اللغة الإنكليزية"
  };
  const STORAGE_KEYS = { cart: "shamLibraryCart.v1", favorites: "shamLibraryFavorites.v1" };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const productGrid = $("#productGrid");
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
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  let selectedGrade = "all";
  let selectedKind = "all";
  let focusedBeforeOverlay = null;
  let activeOverlay = null;
  let toastTimers = new WeakMap();

  function safeLoad(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  function safeSave(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      showToast("تعذّر حفظ التغييرات على هذا الجهاز.");
    }
  }

  const storedCart = safeLoad(STORAGE_KEYS.cart, {});
  let cart = storedCart && typeof storedCart === "object" && !Array.isArray(storedCart) ? storedCart : {};
  const knownIds = new Set(PRODUCTS.map((product) => product.id));
  Object.keys(cart).forEach((id) => {
    if (!knownIds.has(id) || !Number.isFinite(Number(cart[id])) || Number(cart[id]) < 1) delete cart[id];
    else cart[id] = Math.min(99, Math.floor(Number(cart[id])));
  });
  let favorites = safeLoad(STORAGE_KEYS.favorites, []);
  if (!Array.isArray(favorites)) favorites = [];
  favorites = favorites.filter((id) => knownIds.has(id));

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function formatPrice(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) return `— ${escapeHTML(CONFIG.currencyLabel || "د.ع")}`;
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)} ${escapeHTML(CONFIG.currencyLabel || "د.ع")}`;
  }

  function getProduct(id) {
    return PRODUCTS.find((product) => product.id === id);
  }

  function totalItems() {
    return Object.values(cart).reduce((sum, quantity) => sum + Number(quantity || 0), 0);
  }

  function cartTotal() {
    return Object.entries(cart).reduce((sum, [id, quantity]) => {
      const product = getProduct(id);
      return sum + (product ? product.price * quantity : 0);
    }, 0);
  }

  function kindLabel(kind) {
    return kind === "original" ? "أصلي" : "مستنسخ";
  }

  function kindClass(kind) {
    return kind === "original" ? "kind-original" : "kind-copy";
  }

  function getCoverClass(product) {
    return COVER_NAMES[product.cover] ? `cover-${product.cover}` : "cover-chemistry";
  }

  function bookMarkup(product) {
    const symbol = escapeHTML(product.symbol || "✳");
    const title = escapeHTML(COVER_NAMES[product.cover] || product.subject || "ملزمة دراسية");
    const grade = escapeHTML(product.gradeLabel || "مرحلة دراسية");
    return `<div class="product-book" aria-hidden="true">
      <div class="book-brandline"><span>مكتبة الشام</span><span>٢٠٢٦</span></div>
      <div class="book-symbol"><span>${symbol}</span></div>
      <div class="book-title"><small>${grade}</small>${title}</div>
      <div class="book-foot">SHAM LIBRARY / STUDY SERIES</div>
    </div>`;
  }

  function renderProductCard(product) {
    const favorite = favorites.includes(product.id);
    return `<article class="product-card ${getCoverClass(product)}" data-product-id="${escapeHTML(product.id)}">
      <div class="product-visual ${getCoverClass(product)}">
        <span class="product-kind ${kindClass(product.kind)}">${kindLabel(product.kind)}</span>
        <button class="favorite-button ${favorite ? "is-favorite" : ""}" data-action="favorite" data-id="${escapeHTML(product.id)}" type="button" aria-label="${favorite ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}" aria-pressed="${favorite}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 5.8a5 5 0 0 0-7.1 0L12 7.1l-1.3-1.3a5 5 0 0 0-7.1 7.1l1.3 1.3L12 21l7.1-6.8 1.3-1.3a5 5 0 0 0 0-7.1Z"/></svg>
        </button>
        ${bookMarkup(product)}
      </div>
      <div class="product-card-body">
        <div class="product-meta"><span class="grade-label">${escapeHTML(product.gradeLabel || "مرحلة دراسية")}</span><span>${escapeHTML(product.subject || "ملازم")}</span></div>
        <h3>${escapeHTML(product.title)}</h3>
        <p class="product-description">${escapeHTML(product.summary || "تفاصيل المنتج متاحة عند تأكيد الطلب.")}</p>
        <div class="product-card-bottom"><div class="product-price">${formatPrice(product.price)}</div><button type="button" class="add-to-cart" data-action="add" data-id="${escapeHTML(product.id)}" aria-label="إضافة ${escapeHTML(product.title)} إلى السلة" title="إضافة إلى السلة"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>
        <button type="button" class="view-details" data-action="details" data-id="${escapeHTML(product.id)}">تفاصيل الملزمة <span>←</span></button>
      </div>
    </article>`;
  }

  function filteredProducts() {
    const query = (searchInput?.value || "").trim().toLocaleLowerCase("ar");
    let products = PRODUCTS.filter((product) => {
      const gradeMatches = selectedGrade === "all" || product.grade === selectedGrade;
      const kindMatches = selectedKind === "all" || product.kind === selectedKind;
      const searchable = [product.title, product.subject, product.gradeLabel, kindLabel(product.kind), product.summary].join(" ").toLocaleLowerCase("ar");
      return gradeMatches && kindMatches && (!query || searchable.includes(query));
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
    if (!productGrid) return;
    const products = filteredProducts();
    productGrid.innerHTML = products.map(renderProductCard).join("");
    emptyState.hidden = products.length > 0;
    productGrid.hidden = products.length === 0;
    const query = (searchInput?.value || "").trim();
    resultsSummary.innerHTML = query || selectedGrade !== "all" || selectedKind !== "all"
      ? `النتائج المطابقة: <strong>${products.length}</strong> من ${PRODUCTS.length} ملازم`
      : `نعرض لك <strong>${products.length}</strong> ملازم تجريبية`;
  }

  function saveCartAndRender() {
    safeSave(STORAGE_KEYS.cart, cart);
    updateCartBadge();
    renderCart();
    renderProducts();
  }

  function updateCartBadge() {
    const count = totalItems();
    $("#cartCount").textContent = count > 99 ? "99+" : String(count);
    $("#cartCount").setAttribute("aria-label", `${count} قطع في السلة`);
    $("#drawerItemCount").textContent = `(${count})`;
    $("#checkoutCount").textContent = String(count);
    $("#checkoutTotal").textContent = formatPrice(cartTotal());
    $("#cartSubtotal").textContent = formatPrice(cartTotal());
  }

  function renderCart() {
    const entries = Object.entries(cart).filter(([id, quantity]) => getProduct(id) && quantity > 0);
    const isEmpty = entries.length === 0;
    cartEmpty.hidden = !isEmpty;
    drawerFooter.hidden = isEmpty;
    cartItems.hidden = isEmpty;
    if (isEmpty) {
      cartItems.innerHTML = "";
      updateCartBadge();
      return;
    }
    cartItems.innerHTML = entries.map(([id, quantity]) => {
      const product = getProduct(id);
      return `<div class="cart-item" data-cart-id="${escapeHTML(id)}">
        <div class="cart-thumb ${getCoverClass(product)}" aria-hidden="true">${escapeHTML(product.symbol || "✳")}</div>
        <div class="cart-item-info"><h3>${escapeHTML(product.title)}</h3><small>${kindLabel(product.kind)} · ${escapeHTML(product.gradeLabel || "مرحلة دراسية")}</small><div class="quantity-control" aria-label="تعديل الكمية"><button type="button" data-cart-action="decrease" data-id="${escapeHTML(id)}" aria-label="تقليل الكمية">−</button><span>${quantity}</span><button type="button" data-cart-action="increase" data-id="${escapeHTML(id)}" aria-label="زيادة الكمية">+</button></div></div>
        <div><div class="cart-item-price">${formatPrice(product.price * quantity)}</div><button type="button" class="remove-item" data-cart-action="remove" data-id="${escapeHTML(id)}" aria-label="حذف ${escapeHTML(product.title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>
      </div>`;
    }).join("");
    updateCartBadge();
  }

  function addToCart(id) {
    const product = getProduct(id);
    if (!product) return;
    cart[id] = Math.min(99, (cart[id] || 0) + 1);
    saveCartAndRender();
    showToast(`انضافت «${product.subject}» إلى سلتك.`);
  }

  function setFavorite(id) {
    if (!getProduct(id)) return;
    if (favorites.includes(id)) {
      favorites = favorites.filter((favoriteId) => favoriteId !== id);
      showToast("انحذفت الملزمة من المفضلة.");
    } else {
      favorites.push(id);
      showToast("انضافت الملزمة إلى المفضلة.");
    }
    safeSave(STORAGE_KEYS.favorites, favorites);
    renderProducts();
  }

  function showToast(message) {
    if (!toastRegion) return;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<span class="toast-symbol" aria-hidden="true">✓</span><span>${escapeHTML(message)}</span>`;
    toastRegion.appendChild(toast);
    const previousTimer = toastTimers.get(toast);
    if (previousTimer) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), reducedMotion ? 1 : 230);
    }, 2700);
    toastTimers.set(toast, timer);
  }

  function closeMobileMenu() {
    const nav = $("#mainNav");
    const toggle = $("#mobileMenuToggle");
    nav?.classList.remove("is-open");
    toggle?.setAttribute("aria-expanded", "false");
    toggle?.setAttribute("aria-label", "فتح القائمة");
  }

  function updateBodyScrollLock() {
    const anyOpen = Boolean(activeOverlay);
    document.body.classList.toggle("no-scroll", anyOpen);
  }

  function openCart() {
    closeMobileMenu();
    closeCheckout(false);
    closeProductModal(false);
    activeOverlay = "cart";
    const currentFocus = document.activeElement;
    focusedBeforeOverlay = (currentFocus?.closest?.("#productModal, #checkoutModal, #cartDrawer")) ? $("#openCartButton") : currentFocus;
    drawerBackdrop.hidden = false;
    cartDrawer.classList.add("is-open");
    cartDrawer.setAttribute("aria-hidden", "false");
    cartDrawer.inert = false;
    updateBodyScrollLock();
    $("#closeCartButton").focus({ preventScroll: true });
  }

  function closeCart(restoreFocus = true) {
    if (!cartDrawer.classList.contains("is-open")) return;
    cartDrawer.classList.remove("is-open");
    cartDrawer.setAttribute("aria-hidden", "true");
    cartDrawer.inert = true;
    drawerBackdrop.hidden = true;
    if (activeOverlay === "cart") activeOverlay = null;
    updateBodyScrollLock();
    if (restoreFocus && focusedBeforeOverlay?.focus) focusedBeforeOverlay.focus({ preventScroll: true });
  }

  function openCheckout() {
    if (totalItems() < 1) {
      showToast("أضف ملزمة واحدة على الأقل قبل متابعة الطلب.");
      return;
    }
    closeCart(false);
    closeProductModal(false);
    focusedBeforeOverlay = $("#openCartButton");
    activeOverlay = "checkout";
    modalBackdrop.hidden = false;
    checkoutModal.classList.add("is-open");
    checkoutModal.setAttribute("aria-hidden", "false");
    checkoutModal.inert = false;
    $("#checkoutStatus").hidden = true;
    $("#checkoutStatus").innerHTML = "";
    updateCartBadge();
    updateBodyScrollLock();
    window.setTimeout(() => $("#customerName")?.focus({ preventScroll: true }), reducedMotion ? 0 : 120);
  }

  function closeCheckout(restoreFocus = true) {
    if (!checkoutModal.classList.contains("is-open")) return;
    checkoutModal.classList.remove("is-open");
    checkoutModal.setAttribute("aria-hidden", "true");
    checkoutModal.inert = true;
    if (activeOverlay === "checkout") activeOverlay = null;
    if (activeOverlay !== "product") modalBackdrop.hidden = true;
    updateBodyScrollLock();
    if (restoreFocus && focusedBeforeOverlay?.focus) focusedBeforeOverlay.focus({ preventScroll: true });
  }

  function openProductModal(id) {
    const product = getProduct(id);
    if (!product) return;
    closeCart(false);
    closeCheckout(false);
    focusedBeforeOverlay = document.activeElement;
    activeOverlay = "product";
    const content = $("#productModalContent");
    content.innerHTML = `<div class="detail-cover ${getCoverClass(product)}">${bookMarkup(product)}</div>
      <div class="detail-copy"><span class="product-kind ${kindClass(product.kind)}">${kindLabel(product.kind)}</span><h2 id="productModalTitle">${escapeHTML(product.title)}</h2><p>${escapeHTML(product.summary || "تفاصيل المنتج متاحة عند تأكيد الطلب.")}</p><div class="detail-grade">${escapeHTML(product.gradeLabel || "مرحلة دراسية")} · ${escapeHTML(product.subject || "ملازم")}</div><div class="detail-price-row"><strong>${formatPrice(product.price)}</strong><button type="button" class="button button-primary" data-action="add-from-details" data-id="${escapeHTML(product.id)}">أضف للسلة <span>＋</span></button></div></div>`;
    modalBackdrop.hidden = false;
    productModal.classList.add("is-open");
    productModal.setAttribute("aria-hidden", "false");
    productModal.inert = false;
    updateBodyScrollLock();
    $("#closeProductModalButton").focus({ preventScroll: true });
  }

  function closeProductModal(restoreFocus = true) {
    if (!productModal.classList.contains("is-open")) return;
    productModal.classList.remove("is-open");
    productModal.setAttribute("aria-hidden", "true");
    productModal.inert = true;
    if (activeOverlay === "product") activeOverlay = null;
    if (activeOverlay !== "checkout") modalBackdrop.hidden = true;
    updateBodyScrollLock();
    if (restoreFocus && focusedBeforeOverlay?.focus) focusedBeforeOverlay.focus({ preventScroll: true });
  }

  function resetFilters() {
    selectedGrade = "all";
    selectedKind = "all";
    searchInput.value = "";
    sortSelect.value = "featured";
    $$("#gradeFilters .filter-chip").forEach((button) => button.classList.toggle("active", button.dataset.grade === "all"));
    $$("#typeFilters .type-filter").forEach((button) => button.classList.toggle("active", button.dataset.kind === "all"));
    renderProducts();
  }

  function buildOrderMessage(name, phone, notes) {
    const lines = [
      `طلب جديد من موقع ${CONFIG.storeName || "مكتبة الشام"}`,
      "────────────────────",
      `الاسم: ${name}`,
      `رقم الزبون: ${phone}`,
      "",
      "الملازم المطلوبة:"
    ];
    Object.entries(cart).forEach(([id, quantity]) => {
      const product = getProduct(id);
      if (product && quantity > 0) lines.push(`• ${product.title} — ${kindLabel(product.kind)} — الكمية: ${quantity} — ${formatPrice(product.price * quantity)}`);
    });
    lines.push("", `عدد القطع: ${totalItems()}`, `المجموع التقديري: ${formatPrice(cartTotal())}`, "", "يرجى تأكيد التوفر والسعر النهائي.");
    if (notes.trim()) lines.push("", `ملاحظة: ${notes.trim()}`);
    return lines.join("\n");
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      helper.style.pointerEvents = "none";
      document.body.appendChild(helper);
      helper.select();
      const success = document.execCommand("copy");
      helper.remove();
      return success;
    } catch (_) {
      return false;
    }
  }

  function showCheckoutStatus(message, withCopy = false, orderMessage = "") {
    const status = $("#checkoutStatus");
    status.hidden = false;
    status.innerHTML = `<span>${escapeHTML(message)}</span>${withCopy ? ' <button class="copy-order-message" type="button" id="copyOrderMessageButton">نسخ رسالة الطلب</button>' : ""}`;
    if (withCopy) {
      $("#copyOrderMessageButton")?.addEventListener("click", async () => {
        const copied = await copyText(orderMessage);
        showToast(copied ? "تم نسخ رسالة الطلب." : "تعذّر النسخ تلقائياً؛ جرّب من متصفح آخر.");
      }, { once: true });
    }
  }

  /* Rendering & initial setup */
  $("#currentYear").textContent = String(new Date().getFullYear());
  $("#gradeFilters .filter-chip[data-grade='all'] span").textContent = String(PRODUCTS.length).padStart(2, "0");
  renderProducts();
  renderCart();
  updateCartBadge();

  /* Catalog controls */
  searchInput.addEventListener("input", renderProducts);
  sortSelect.addEventListener("change", renderProducts);
  $("#gradeFilters").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-grade]");
    if (!button) return;
    const grade = button.dataset.grade;
    if (grade !== "all" && !VALID_GRADES.has(grade)) return;
    selectedGrade = grade;
    $$("#gradeFilters .filter-chip").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    renderProducts();
  });
  $("#typeFilters").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-kind]");
    if (!button) return;
    const kind = button.dataset.kind;
    if (kind !== "all" && !VALID_KINDS.has(kind)) return;
    selectedKind = kind;
    $$("#typeFilters .type-filter").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    renderProducts();
  });
  $("#clearFiltersButton").addEventListener("click", resetFilters);
  $("#emptyResetButton").addEventListener("click", resetFilters);
  $("#searchFocusButton").addEventListener("click", () => {
    document.querySelector("#catalog").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
    window.setTimeout(() => searchInput.focus({ preventScroll: true }), reducedMotion ? 0 : 350);
  });

  /* Delegated product actions */
  productGrid.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === "add") addToCart(id);
    else if (action === "favorite") setFavorite(id);
    else if (action === "details") openProductModal(id);
  });
  $("#productModalContent").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action='add-from-details']");
    if (!button) return;
    const id = button.dataset.id;
    closeProductModal(false);
    addToCart(id);
    openCart();
  });

  /* Cart interactions */
  $("#openCartButton").addEventListener("click", openCart);
  $("#closeCartButton").addEventListener("click", () => closeCart());
  $("#browseFromCartButton").addEventListener("click", () => {
    closeCart(false);
    document.querySelector("#catalog").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
  });
  $("#continueShoppingButton").addEventListener("click", () => closeCart());
  drawerBackdrop.addEventListener("click", () => closeCart());
  cartItems.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-cart-action]");
    if (!button) return;
    const { cartAction, id } = button.dataset;
    if (!getProduct(id)) return;
    if (cartAction === "increase") cart[id] = Math.min(99, (cart[id] || 0) + 1);
    else if (cartAction === "decrease") {
      cart[id] = (cart[id] || 0) - 1;
      if (cart[id] < 1) delete cart[id];
    } else if (cartAction === "remove") delete cart[id];
    saveCartAndRender();
  });
  $("#checkoutButton").addEventListener("click", openCheckout);

  /* Checkout */
  $("#closeCheckoutButton").addEventListener("click", () => closeCheckout());
  $("#checkoutForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (totalItems() < 1) {
      showCheckoutStatus("سلتك فارغة. أضف الملازم التي تحتاجها أولاً.");
      return;
    }
    const name = $("#customerName").value.trim();
    const phone = $("#customerPhone").value.trim();
    const notes = $("#orderNotes").value.trim();
    if (name.length < 2) {
      $("#customerName").focus();
      showCheckoutStatus("اكتب اسمك حتى نجهّز الطلب.");
      return;
    }
    if (phone.replace(/\D/g, "").length < 7) {
      $("#customerPhone").focus();
      showCheckoutStatus("تأكد من كتابة رقم هاتف صحيح.");
      return;
    }
    const orderMessage = buildOrderMessage(name, phone, notes);
    const whatsappNumber = String(CONFIG.whatsappNumber || "").replace(/\D/g, "");
    if (!whatsappNumber || /X/i.test(String(CONFIG.whatsappNumber))) {
      showCheckoutStatus("لم يُضف رقم واتساب المكتبة بعد. أضِفه في الملف js/config.js لتفعيل الإرسال، أو انسخ رسالة الطلب الآن.", true, orderMessage);
      return;
    }
    const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(orderMessage)}`;
    const openedWindow = window.open(whatsappUrl, "_blank", "noopener,noreferrer");
    if (openedWindow) {
      showCheckoutStatus("فتحنا واتساب برسالة الطلب الجاهزة. راجع التفاصيل وأرسلها بعد تأكيدها.");
    } else {
      showCheckoutStatus("قد يمنع المتصفح فتح واتساب تلقائياً. انسخ رسالة الطلب وافتح واتساب يدوياً.", true, orderMessage);
    }
  });

  /* Details modal and overlay dismissal */
  $("#closeProductModalButton").addEventListener("click", () => closeProductModal());
  modalBackdrop.addEventListener("click", () => {
    if (activeOverlay === "checkout") closeCheckout();
    else if (activeOverlay === "product") closeProductModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (activeOverlay === "checkout") closeCheckout();
      else if (activeOverlay === "product") closeProductModal();
      else if (activeOverlay === "cart") closeCart();
      closeMobileMenu();
    }
  });

  /* Mobile navigation */
  const mobileToggle = $("#mobileMenuToggle");
  const mainNav = $("#mainNav");
  mobileToggle.addEventListener("click", () => {
    const open = !mainNav.classList.contains("is-open");
    mainNav.classList.toggle("is-open", open);
    mobileToggle.setAttribute("aria-expanded", String(open));
    mobileToggle.setAttribute("aria-label", open ? "إغلاق القائمة" : "فتح القائمة");
  });
  $$(".main-nav a").forEach((link) => link.addEventListener("click", closeMobileMenu));

  /* Keep the interface resilient if a product id was removed from the data file. */
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEYS.cart) {
      const latestCart = safeLoad(STORAGE_KEYS.cart, {});
      if (latestCart && typeof latestCart === "object" && !Array.isArray(latestCart)) {
        cart = Object.fromEntries(Object.entries(latestCart).filter(([id, qty]) => knownIds.has(id) && Number.isFinite(Number(qty)) && Number(qty) > 0).map(([id, qty]) => [id, Math.min(99, Math.floor(Number(qty)))]));
        renderCart();
      }
    }
  });
})();
