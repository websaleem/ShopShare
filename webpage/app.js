/* ShopShare frontend.
 *
 * API endpoints (fronted by CloudFront, forwarded to the Lambda Function URL):
 *   GET  /shopshare/api/state       — fetch user state
 *   POST /shopshare/api/state       — save user state
 *   POST /shopshare/api/extract     — body { mime_type, data_b64 } → list of items
 *   POST /shopshare/api/upload-url  — body { filename, content_type } → presigned PUT URL
 */

const BASE_URL = SHOPSHARE_CONFIG.API_BASE_URL;
const API_EXTRACT = `${BASE_URL}/shopshare/api/extract`;
const API_UPLOAD  = `${BASE_URL}/shopshare/api/upload-url`;
const API_STATE   = `${BASE_URL}/shopshare/api/state`;
const MAX_BYTES = 5 * 1024 * 1024;
const UNASSIGNED = "Unassigned";

// Configuration for Cognito (loaded from config.js)
const COGNITO_USER_POOL_ID = SHOPSHARE_CONFIG.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = SHOPSHARE_CONFIG.COGNITO_CLIENT_ID;

let userPool;
let cognitoUser;
let jwtToken = null;
let stateLoaded = false;

let state = {
    shopName: "",
    purchaseDate: "",
    people: ["Me"],
    peopleEmails: {},
    items: [],          // {Item, Price, BelongsTo}
    pending: [],        // {Item, Price, BelongsTo}
    uploads: [],        // {key, filename, uploadedAt}
    history: [],        // saved past bills
    includeTax: false,
    taxPct: 0,
    discountPct: 0,
};

// ───────── DOM helpers ─────────
const $ = (id) => document.getElementById(id);
const fmt = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
// Security: escapes user-supplied strings before inserting into innerHTML
const escapeHtml = (str) => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

function showToast(message, type = "info") {
    let container = $("toastContainer");
    if (!container) {
        container = document.createElement("div");
        container.id = "toastContainer";
        container.className = "toast-container";
        document.body.appendChild(container);
    }
    
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    
    let icon = "fa-info-circle";
    if (type === "success") icon = "fa-check-circle";
    if (type === "error") icon = "fa-exclamation-circle";
    
    // Use textContent for message to prevent XSS from API error strings
    const iconEl = document.createElement('i');
    iconEl.className = `fas ${icon}`;
    const msgEl = document.createElement('span');
    msgEl.textContent = message;
    toast.appendChild(iconEl);
    toast.appendChild(msgEl);
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add("fade-out");
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// C-1 fix: build confirm modal with DOM API (not innerHTML) so message cannot inject HTML/JS
function confirmModal(message) {
    return new Promise((resolve) => {
        const container = document.createElement("div");
        container.className = "auth-overlay";
        container.style.zIndex = "9999";

        const card = document.createElement("div");
        card.className = "auth-card";
        card.style.cssText = "text-align:center; max-width:400px; padding:2rem;";

        const title = document.createElement("h2");
        title.style.cssText = "margin-top:0; color:var(--primary-dark); font-size:1.3rem;";
        title.textContent = "Confirm Action";

        const msg = document.createElement("p");
        msg.style.cssText = "margin:1.5rem 0; color:var(--text); font-size:1rem; line-height:1.5;";
        msg.textContent = message; // textContent prevents XSS

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex; justify-content:center; gap:1rem; margin-top:2rem;";

        const cancelBtn = document.createElement("button");
        cancelBtn.className = "btn btn-secondary";
        cancelBtn.style.cssText = "flex:1; margin:0;";
        cancelBtn.textContent = "Cancel";

        const okBtn = document.createElement("button");
        okBtn.className = "btn btn-danger";
        okBtn.style.cssText = "flex:1; margin:0;";
        okBtn.textContent = "Proceed";

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        card.appendChild(title);
        card.appendChild(msg);
        card.appendChild(btnRow);
        container.appendChild(card);
        document.body.appendChild(container);

        const cleanup = () => { container.remove(); };
        okBtn.addEventListener("click", () => { cleanup(); resolve(true); });
        cancelBtn.addEventListener("click", () => { cleanup(); resolve(false); });
    });
}

// Safe helper: sets "Logged in as <name> Edit" without innerHTML
function _setCurrentUserDisplay(name) {
    const el = $("currentUserDisplay");
    if (!el) return;
    el.textContent = "";
    const strong = document.createElement("strong");
    strong.textContent = name;
    el.append("Logged in as ", strong, " ");
    const editLink = document.createElement("a");
    editLink.href = "#";
    editLink.textContent = "Edit";
    editLink.style.cssText = "color: var(--primary-dark); margin-left: 8px; font-size: 0.9em; text-decoration: underline;";
    editLink.addEventListener("click", (e) => openProfileModal(e, true));
    el.appendChild(editLink);
}

// ───────── Auth Flow ─────────
function initAuth() {
    if (!window.AmazonCognitoIdentity) {
        console.error("Cognito Identity JS not loaded.");
        return;
    }
    const poolData = {
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID
    };
    userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);
    cognitoUser = userPool.getCurrentUser();

    if (cognitoUser) {
        cognitoUser.getSession(async (err, session) => {
            if (err || !session.isValid()) {
                showAuth();
            } else {
                jwtToken = session.getAccessToken().getJwtToken();
                hideAuth();
                _setCurrentUserDisplay(cognitoUser.getUsername());
                await loadState();
                fetchUserAttributes();
            }
        });
    } else {
        showAuth();
    }
}

let isSignUp = false;
let forgetPasswordStep = 0;
let unconfirmedUser = null;

function showAuth() {
    if ($("landingView")) $("landingView").classList.remove("hidden");
    if ($("app")) $("app").classList.add("hidden");
}

function hideAuth() {
    if ($("landingView")) $("landingView").classList.add("hidden");
    if ($("app")) $("app").classList.remove("hidden");
}

function handleAuthSubmit(e) {
    e.preventDefault();
    $("authError").textContent = "";
    try {
        const email = $("authEmail").value.trim();
        const password = $("authPassword").value;
        const code = $("authCode").value.trim();
        const name = $("authName") ? $("authName").value.trim() : "";
        
        if (!email) {
            $("authError").textContent = "Please enter your email.";
            $("authError").style.color = "var(--danger)";
            return;
        }
        if (!userPool) {
            $("authError").textContent = "Authentication system not loaded. Please refresh the page.";
            $("authError").style.color = "var(--danger)";
            return;
        }

    if (unconfirmedUser) {
        // Confirm code
        unconfirmedUser.confirmRegistration(code, true, (err, result) => {
            if (err) {
                $("authError").textContent = err.message || JSON.stringify(err);
                return;
            }
            unconfirmedUser = null;
            $("authCodeSection").classList.add("hidden");
            isSignUp = false;
            $("authTitle").textContent = "Log In";
            $("authSubmitBtn").textContent = "Log In";
            $("authSwitchText").textContent = "Don't have an account?";
            $("authSwitchBtn").textContent = "Sign Up";
            $("authError").textContent = "Verified! Please log in.";
            $("authError").style.color = "var(--primary-dark)";
        });
        return;
    }

    if (forgetPasswordStep === 1) {
        const cognitoUserObj = new AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: userPool });
        cognitoUserObj.forgotPassword({
            onSuccess: (data) => {
                // Should technically transition to step 2 in inputVerificationCode, but we can do it here just in case.
                forgetPasswordStep = 2;
                $("authCodeSection").classList.remove("hidden");
                $("authPasswordField").classList.remove("hidden");
                $("authPasswordField").querySelector("span").textContent = "New Password";
                $("authTitle").textContent = "Reset Password";
                $("authSubmitBtn").textContent = "Set New Password";
                $("authError").textContent = "Enter verification code and new password.";
                $("authError").style.color = "var(--text-main)";
            },
            onFailure: (err) => {
                $("authError").textContent = err.message || JSON.stringify(err);
                $("authError").style.color = "var(--danger)";
            },
            inputVerificationCode: (data) => {
                forgetPasswordStep = 2;
                $("authCodeSection").classList.remove("hidden");
                $("authPasswordField").classList.remove("hidden");
                $("authPasswordField").querySelector("span").textContent = "New Password";
                $("authTitle").textContent = "Reset Password";
                $("authSubmitBtn").textContent = "Set New Password";
                $("authError").textContent = "Check your email for the reset code.";
                $("authError").style.color = "var(--text-main)";
            }
        });
        return;
    }

    if (forgetPasswordStep === 2) {
        if (!code || !password) {
            $("authError").textContent = "Please enter verification code and new password.";
            $("authError").style.color = "var(--danger)";
            return;
        }
        const cognitoUserObj = new AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: userPool });
        cognitoUserObj.confirmPassword(code, password, {
            onSuccess() {
                forgetPasswordStep = 0;
                $("authCodeSection").classList.add("hidden");
                $("authPasswordField").querySelector("span").textContent = "Password";
                $("authTitle").textContent = "Log In";
                $("authSubmitBtn").textContent = "Log In";
                if ($("authForgotBtn")) $("authForgotBtn").style.display = "block";
                $("authSwitchText").parentNode.style.display = "block";
                $("authError").textContent = "Password reset successfully. Please log in.";
                $("authError").style.color = "var(--primary-dark)";
                $("authPassword").value = "";
                $("authCode").value = "";
            },
            onFailure(err) {
                $("authError").textContent = err.message || JSON.stringify(err);
                $("authError").style.color = "var(--danger)";
            }
        });
        return;
    }

    if (isSignUp) {
        const attributeList = [
            new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'email', Value: email })
        ];
        if (name) {
            attributeList.push(new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'name', Value: name }));
        }
        userPool.signUp(email, password, attributeList, null, (err, result) => {
            if (err) {
                if (err.code === 'UsernameExistsException') {
                    $("authError").textContent = "Account already created. Please log in.";
                } else {
                    $("authError").textContent = err.message || JSON.stringify(err);
                }
                return;
            }
            unconfirmedUser = result.user;
            $("authCodeSection").classList.remove("hidden");
            $("authTitle").textContent = "Verify Email";
            $("authSubmitBtn").textContent = "Verify";
            $("authError").textContent = "Check your email for the verification code.";
            $("authError").style.color = "var(--text-main)";
        });
    } else {
        const authenticationDetails = new AmazonCognitoIdentity.AuthenticationDetails({
            Username: email,
            Password: password,
        });
        const userData = { Username: email, Pool: userPool };
        cognitoUser = new AmazonCognitoIdentity.CognitoUser(userData);
        
        cognitoUser.authenticateUser(authenticationDetails, {
            onSuccess: async (result) => {
                jwtToken = result.getAccessToken().getJwtToken();
                hideAuth();
                _setCurrentUserDisplay(cognitoUser.getUsername());
                await loadState();
                fetchUserAttributes();
            },
            onFailure: (err) => {
                $("authError").textContent = err.message || JSON.stringify(err);
                $("authError").style.color = "var(--danger)";
            },
        });
    }
    } catch (globalErr) {
        $("authError").textContent = "JS Error: " + globalErr.message;
        $("authError").style.color = "var(--danger)";
    }
}

function fetchUserAttributes() {
    if (!cognitoUser) return;
    cognitoUser.getUserAttributes((err, attributes) => {
        if (err) return;
        const nameAttr = attributes.find(a => a.getName() === 'name');
        const emailAttr = attributes.find(a => a.getName() === 'email');
        const fullName = nameAttr ? nameAttr.getValue() : "Me";
        const email = emailAttr ? emailAttr.getValue() : "";
        const navLink = $("navProfileLink");
        if (navLink) {
            navLink.textContent = `Hi, ${fullName}`;
            navLink.classList.remove("hidden");
            navLink.dataset.currentName = fullName;
        }
        if ($("profileName")) {
            $("profileName").value = fullName;
        }
        if ($("profileEmail")) {
            $("profileEmail").value = email;
        }
        if ($("currentUserDisplay")) {
            _setCurrentUserDisplay(fullName);
        }
        if (!state.peopleEmails) state.peopleEmails = {};
        state.peopleEmails[fullName] = email;
        
        if (state.people[0] === "Me" || state.people[0] === cognitoUser.getUsername()) {
            state.people[0] = fullName;
            renderAll();
        } else {
            // Render to show the updated email if name didn't change
            renderAll();
        }
    });
}

// ───────── Sync ─────────
let syncTimeout = null;

// Fix #11: Auto-refresh JWT token before it expires (Cognito tokens expire in 1 hour)
async function refreshTokenIfNeeded() {
    try {
        if (!cognitoUser) return;
        let session = null;
        try {
            session = cognitoUser.getSignInUserSession();
        } catch (e) {
            // getSignInUserSession throws if no session is set
            return;
        }
        if (!session) return;
        const token = session.getAccessToken();
        const expiresInMs = (token.getExpiration() * 1000) - Date.now();
        if (expiresInMs < 5 * 60 * 1000) {
            await new Promise((resolve, reject) => {
                cognitoUser.refreshSession(session.getRefreshToken(), (err, newSession) => {
                    if (err) { console.warn("Token refresh failed:", err); resolve(); return; }
                    jwtToken = newSession.getAccessToken().getJwtToken();
                    resolve();
                });
            });
        }
    } catch (err) {
        console.warn("refreshTokenIfNeeded error:", err);
    }
}

function triggerSync() {
    if (syncTimeout) clearTimeout(syncTimeout);
    $("syncStatus").textContent = "Saving...";
    syncTimeout = setTimeout(syncState, 1000);
}

async function syncState() {
    await refreshTokenIfNeeded();
    if (!jwtToken) return;
    try {
        const cloudPayload = { ...state };
        delete cloudPayload.items;
        delete cloudPayload.pending;
        delete cloudPayload.uploads;
        delete cloudPayload.shopName;
        delete cloudPayload.purchaseDate;

        // Safety guard: never overwrite cloud state if we haven't successfully loaded it first
        if (!stateLoaded) {
            console.warn("[syncState] Blocked: state not successfully loaded from cloud yet.");
            return;
        }

        // Safety guard: never overwrite a populated people list with a bare default
        if (!cloudPayload.people || cloudPayload.people.length === 0) {
            console.warn("[syncState] Blocked: people array is empty, skipping sync.");
            return;
        }

        const res = await fetch(API_STATE, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${jwtToken}`
            },
            body: JSON.stringify({ state: JSON.stringify(cloudPayload) })
        });
        // M-3: Surface 413 clearly so user knows why data wasn't saved
        if (res.status === 413) throw new Error("State too large — please clear some history to free space.");
        if (!res.ok) throw new Error(`Sync failed (HTTP ${res.status})`);
        $("syncStatus").textContent = "All changes saved to cloud";
        setTimeout(() => {
            if ($("syncStatus").textContent === "All changes saved to cloud") {
                $("syncStatus").textContent = "";
            }
        }, 3000);
    } catch (e) {
        console.error(e);
        // M-5: Show specific error message to user, not generic text
        $("syncStatus").textContent = e.message || "Error saving changes";
    }
}

async function loadState() {
    await refreshTokenIfNeeded();
    if (!jwtToken) return;
    try {
        $("syncStatus").textContent = "Loading...";
        const res = await fetch(API_STATE, {
            method: "GET",
            headers: { "Authorization": `Bearer ${jwtToken}` }
        });
        if (!res.ok) throw new Error("Load failed");
        const data = await res.json();
        
        let cloudState = data.state;
        if (cloudState && typeof cloudState === 'string') {
            try {
                cloudState = JSON.parse(cloudState);
            } catch (e) {
                console.error("Failed to parse cloud state", e);
            }
        }
        
        if (cloudState && Object.keys(cloudState).length > 0) {
            state = { ...state, ...cloudState };
        }

        stateLoaded = true; // Mark that we've safely retrieved the source of truth

        // Fresh session: clear transient data (items/pending/shopName).
        // People, history, settings (tax/discount) persist across sessions.
        // Users must click "Save Bill" to move items into history before they log out.
        state.items = [];
        state.pending = [];
        state.uploads = [];
        state.shopName = "";
        state.purchaseDate = "";

        $("syncStatus").textContent = "";
        renderAll();
        // NOTE: Do NOT call triggerSync() here. loadState is read-only.
        // Syncing back is handled only by explicit mutations (saveState).
        // Calling triggerSync here risks overwriting good DynamoDB data with
        // a partially-initialised in-memory state (e.g. before fetchUserAttributes
        // has had a chance to restore the correct user name/email).
    } catch (e) {
        console.error(e);
        $("syncStatus").textContent = "Error loading state";
    }
}

// Helper to wrap state mutations
function saveState(mutationFn) {
    mutationFn();
    renderAll();
    triggerSync();
}

// ───────── Render ─────────
function renderPeople() {
    const list = $("peopleList");
    list.innerHTML = "";
    state.people.forEach((p, idx) => {
        const li = document.createElement("li");
        
        const infoDiv = document.createElement("div");
        infoDiv.style.display = "flex";
        infoDiv.style.flexDirection = "column";
        
        const nameSpan = document.createElement("span");
        nameSpan.textContent = p;
        infoDiv.appendChild(nameSpan);
        
        if (state.peopleEmails && state.peopleEmails[p]) {
            const emailSpan = document.createElement("span");
            emailSpan.textContent = state.peopleEmails[p];
            emailSpan.style.fontSize = "0.8rem";
            emailSpan.style.color = "var(--text-muted)";
            infoDiv.appendChild(emailSpan);
        }
        
        li.appendChild(infoDiv);

        if (idx > 0) {
            const del = document.createElement("button");
            del.innerHTML = '<i class="fas fa-times"></i>';
            del.className = "btn btn-icon";
            del.onclick = async () => {
                if (!(await confirmModal("Remove this person?"))) return;
                saveState(() => {
                    state.people.splice(idx, 1);
                    if (state.peopleEmails) delete state.peopleEmails[p];
                    // Unassign
                    state.items.forEach(it => { if (it.BelongsTo === p) it.BelongsTo = UNASSIGNED; });
                    state.pending.forEach(it => { if (it.BelongsTo === p) it.BelongsTo = UNASSIGNED; });
                });
            };
            li.appendChild(del);
        }
        list.appendChild(li);
    });
    
    const sel = $("manualBelongs");
    const prev = sel.value;
    sel.innerHTML = "";
    for (const p of state.people) {
        const o = document.createElement("option");
        o.value = p; o.textContent = p;
        sel.appendChild(o);
    }
    if (state.people.includes(prev)) sel.value = prev;
}

function renderItems() {
    const tbody = document.querySelector("#itemsTable tbody");
    tbody.innerHTML = "";
    
    if (state.items.length === 0) {
        $("itemsTable").style.display = "none";
        $("itemsEmpty").style.display = "block";
        if ($("clearItemsBtn")) $("clearItemsBtn").style.display = "none";
        return;
    }
    
    $("itemsTable").style.display = "table";
    $("itemsEmpty").style.display = "none";
    if ($("clearItemsBtn")) $("clearItemsBtn").style.display = "inline-flex";
    state.items.forEach((it, idx) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td></td><td class="num"></td><td></td><td style="white-space: nowrap; text-align: right;"><button class="split-btn" title="Split Item"><i class="fas fa-cut"></i></button> <button class="remove" title="Remove">&times;</button></td>`;
        tr.children[0].textContent = it.Item;
        tr.children[1].textContent = fmt(it.Price);
        tr.children[2].textContent = it.BelongsTo;
        tr.querySelector(".split-btn").addEventListener("click", () => splitItem(idx, state.items));
        tr.querySelector(".remove").addEventListener("click", async () => {
            if (!(await confirmModal("Remove this item?"))) return;
            saveState(() => {
                state.items.splice(idx, 1);
            });
        });
        tbody.appendChild(tr);
    });
}

function renderPending() {
    const wrap = $("pendingWrap");
    const list = $("pendingList");
    list.innerHTML = "";
    if ($("pendingExtractedItemsTitle")) {
        $("pendingExtractedItemsTitle").textContent = `Pending Extracted Items${state.shopName ? ` from ${state.shopName}` : ''}${state.purchaseDate ? ` on ${state.purchaseDate}` : ''}`;
    }
    
    if (!state.pending.length && !state.items.length) {
        wrap.classList.add("hidden");
        return;
    }
    wrap.classList.remove("hidden");
    
    if (!state.pending.length) {
        if ($("pendingExtractedItemsTitle")) $("pendingExtractedItemsTitle").style.display = "none";
        if ($("pendingExtractedItemsHint")) $("pendingExtractedItemsHint").style.display = "none";
    } else {
        if ($("pendingExtractedItemsTitle")) $("pendingExtractedItemsTitle").style.display = "block";
        if ($("pendingExtractedItemsHint")) $("pendingExtractedItemsHint").style.display = "block";
    }
    state.pending.forEach((it, idx) => {
        const row = document.createElement("div");
        row.className = "pending-row";

        const nameInp = document.createElement("input");
        nameInp.type = "text"; nameInp.value = it.Item || "";
        nameInp.addEventListener("input", () => saveState(() => { state.pending[idx].Item = nameInp.value; }));

        const priceInp = document.createElement("input");
        priceInp.type = "number"; priceInp.step = "0.01"; priceInp.min = "0";
        priceInp.value = Number(it.Price) || 0;
        priceInp.addEventListener("input", () => saveState(() => { state.pending[idx].Price = parseFloat(priceInp.value) || 0; }));

        const belongsSel = document.createElement("select");
        for (const p of state.people) {
            const o = document.createElement("option");
            o.value = p; o.textContent = p;
            belongsSel.appendChild(o);
        }
        if (state.people.includes(it.BelongsTo)) belongsSel.value = it.BelongsTo;
        else state.pending[idx].BelongsTo = belongsSel.value;
        belongsSel.addEventListener("change", () => saveState(() => { state.pending[idx].BelongsTo = belongsSel.value; }));

        const splitBtn = document.createElement("button");
        splitBtn.className = "remove"; // Using remove class for identical base styling
        splitBtn.innerHTML = '<i class="fas fa-cut"></i>';
        splitBtn.title = "Split Item";
        splitBtn.style.color = "var(--text-muted)";
        splitBtn.addEventListener("mouseover", () => splitBtn.style.color = "var(--primary)");
        splitBtn.addEventListener("mouseout", () => splitBtn.style.color = "var(--text-muted)");
        splitBtn.addEventListener("click", () => splitItem(idx, state.pending));

        const remove = document.createElement("button");
        remove.className = "remove"; remove.innerHTML = "&times;";
        remove.addEventListener("click", () => saveState(() => { state.pending.splice(idx, 1); }));

        row.append(nameInp, priceInp, belongsSel, splitBtn, remove);
        list.appendChild(row);
    });
}

function renderUploadHistory() {
    const wrap = $("uploadHistory");
    wrap.innerHTML = "";
    const moreContainer = $("uploadHistoryMoreContainer");
    if (moreContainer) moreContainer.innerHTML = "";
    
    if (!state.history || !state.history.length) {
        wrap.innerHTML = '<p class="hint">No scanned history yet.</p>';
        return;
    }
    
    const maxItems = window._showAllHistory ? state.history.length : 5;
    const itemsToShow = state.history.slice(0, maxItems);
    
    for (const h of itemsToShow) {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.padding = "0.5rem 0";
        row.style.borderBottom = "1px solid var(--border)";
        row.style.alignItems = "center";
        
        const rawDate = new Date(h.date);
        const d = isNaN(rawDate) ? "Unknown date" : rawDate.toLocaleDateString();
        const totalDisplay = isFinite(h.total) ? fmt(h.total) : "$0.00";
        row.innerHTML = `
            <div>
                <strong style="color:var(--primary);">${escapeHtml(h.shopName || "Unknown Shop")}</strong><br>
                <small style="color:var(--text-muted);">${escapeHtml(d)}</small>
            </div>
            <div style="text-align:right;">
                <strong>${escapeHtml(totalDisplay)}</strong>
            </div>
        `;
        wrap.appendChild(row);
    }
    
    if (state.history.length > 5 && moreContainer) {
        if (!window._showAllHistory) {
            const btn = document.createElement("button");
            btn.className = "btn btn-sm btn-secondary";
            btn.textContent = "Show More";
            btn.onclick = () => {
                window._showAllHistory = true;
                renderUploadHistory();
            };
            moreContainer.appendChild(btn);
        } else {
            const btn = document.createElement("button");
            btn.className = "btn btn-sm btn-secondary";
            btn.textContent = "Show Less";
            btn.onclick = () => {
                window._showAllHistory = false;
                renderUploadHistory();
            };
            moreContainer.appendChild(btn);
        }
    }
}

function renderUploads() {
    const wrap = $("uploadHistory");
    wrap.innerHTML = "";
    if (!state.uploads.length) return;
    for (const u of state.uploads) {
        const row = document.createElement("div");
        row.className = "uh-row";
        row.innerHTML = `<span><i class="fas fa-check-circle" style="color:var(--primary)"></i> </span><code></code>`;
        row.children[0].insertAdjacentText("beforeend", `${u.filename} `);
        row.children[1].textContent = u.key;
        wrap.appendChild(row);
    }
}

function renderSummary() {
    const subtotals = Object.fromEntries(state.people.map((p) => [p, 0]));
    for (const it of state.items) {
        if (it.BelongsTo in subtotals) {
            subtotals[it.BelongsTo] += Number(it.Price) || 0;
        } else {
            subtotals[UNASSIGNED] = (subtotals[UNASSIGNED] || 0) + (Number(it.Price) || 0);
        }
    }
    const subtotal = Object.values(subtotals).reduce((a, b) => a + b, 0);

    // Use state values directly — auto-defaults are set when shopName changes
    const taxPct = state.includeTax ? (state.taxPct || 0) : 0;
    const discountPct = state.discountPct || 0;

    // Formula: tax on subtotal, then discount on (subtotal + tax)
    const tax      = subtotal * (taxPct / 100);
    const totalBill = subtotal + tax;
    const discount = totalBill * (discountPct / 100);
    const finalTotal = totalBill - discount;

    if ($("totalBillVal")) $("totalBillVal").textContent = fmt(totalBill);
    $("subtotalVal").textContent = fmt(subtotal);
    $("taxLabel").textContent = `Service Tax (${taxPct}%)`;
    $("taxVal").textContent = "+ " + fmt(tax);
    $("discountLabel").textContent = `Discount (${discountPct}%)`;
    $("discountVal").textContent = "− " + fmt(discount);
    $("totalLine").textContent = "";
    $("totalLine").append("Total Amount to Pay: ");
    const totalStrong = document.createElement("strong");
    totalStrong.textContent = fmt(finalTotal);
    $("totalLine").appendChild(totalStrong);

    const oweList = $("oweList");
    oweList.innerHTML = "";
    if (subtotal === 0) {
        oweList.innerHTML = `<p class="empty">Add items to see the split.</p>`;
        return;
    }
    for (const [person, personSubtotal] of Object.entries(subtotals)) {
        if (personSubtotal === 0 && person !== UNASSIGNED) continue;
        const share = personSubtotal / subtotal;
        const owed = finalTotal * share;
        const personTotal = personSubtotal + (personSubtotal * (taxPct / 100));
        
        const row = document.createElement("div");
        row.className = "owe-row" + (person === UNASSIGNED ? " unassigned" : "");
        row.innerHTML = `<span><strong></strong> owes</span><span style="display:flex; align-items:center; gap:0.5rem;"><span class="owe-amount"></span> <button class="btn btn-sm btn-outline share-bill-btn" style="padding:0.3rem 0.6rem; font-size:0.9rem; display:flex; align-items:center; gap:0.3rem;" title="Send the bill"><i class="fas fa-share"></i> Share</button></span>`;
        row.querySelector("strong").textContent = person;
        row.querySelector(".owe-amount").textContent = `${fmt(owed)}  (total ${fmt(personTotal)})`;
        
        if (person === UNASSIGNED) {
            row.querySelector(".share-bill-btn").style.display = "none";
        } else {
            const btn = row.querySelector(".share-bill-btn");
            btn.addEventListener("click", async () => {
                if (!cognitoUser) {
                    showToast("You must be logged in to share a bill.", "error");
                    return;
                }
                const email = state.peopleEmails[person];
                if (!email) {
                    showToast(`No email configured for ${person}. Please set their email in the People tab first.`, "info");
                    return;
                }
                try {
                    btn.disabled = true;
                    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Sharing…`;
                    await refreshTokenIfNeeded();
                    if (!jwtToken) {
                        showToast("Session expired. Please log in again.", "error");
                        btn.innerHTML = `<i class="fas fa-share"></i> Share`;
                        btn.disabled = false;
                        return;
                    }
                    const res = await fetch(`${BASE_URL}/shopshare/api/share`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${jwtToken}`
                        },
                        body: JSON.stringify({
                            email: email,
                            name: person,
                            shopName: state.shopName || "",
                            items: state.items,
                            taxPct: state.includeTax ? (state.taxPct || 0) : 0,
                            discountPct: state.discountPct || 0
                        })
                    });
                    
                    const data = await res.json();
                    if (res.ok) {
                        showToast(`Successfully shared bill with ${person} at ${email}!`, "success");
                        btn.innerHTML = `<i class="fas fa-redo"></i> Re-send`;
                        btn.style.borderColor = "#10b981";
                        btn.style.color = "#10b981";
                        btn.disabled = false;
                        btn.title = "Re-send the bill";
                    } else {
                        showToast(`Failed to share: ${data.error || "Unknown error"}`, "error");
                        btn.innerHTML = `<i class="fas fa-exclamation-circle" style="color: #ef4444;"></i> Retry`;
                        btn.style.borderColor = "#ef4444";
                        btn.style.color = "#ef4444";
                        btn.disabled = false;
                    }
                } catch(e) {
                    showToast("Network Error while sharing.", "error");
                    btn.innerHTML = `<i class="fas fa-exclamation-circle" style="color: #ef4444;"></i> Retry`;
                    btn.style.borderColor = "#ef4444";
                    btn.style.color = "#ef4444";
                    btn.disabled = false;
                }
            });
        }
        
        oweList.appendChild(row);
    }
}

function renderAll() {
    renderPeople();
    renderItems();
    renderPending();
    renderUploads();
    renderUploadHistory();
    renderSummary();
    $("includeTax").checked = state.includeTax;
    $("taxPct").value = state.taxPct;
    $("discountPct").value = state.discountPct;
    if ($("shopNameInput") && $("shopNameInput").value !== (state.shopName || "")) {
        $("shopNameInput").value = state.shopName || "";
    }
}

// ───────── Mutations ─────────
function addPerson(name, email) {
    const trimmed = name.trim();
    if (!trimmed) return;
    
    saveState(() => {
        if (!state.people.includes(trimmed)) {
            state.people.push(trimmed);
        }
        if (email) {
            if (!state.peopleEmails) state.peopleEmails = {};
            state.peopleEmails[trimmed] = email.trim();
        }
    });
}

async function clearAll() {
    const ok = await confirmModal("Clear all items, people, pending items, and the upload list? (Files already uploaded to S3 are not deleted.)");
    if (!ok) return;
    saveState(() => {
        state.items = [];
        state.pending = [];
        state.uploads = [];
        state.people = [cognitoUser ? $("navProfileLink").dataset.currentName || "Me" : "Me"];
        state.history = [];
    });
    setExtractStatus("");
    setUploadStatus("");
}

let currentSplitIndex = -1;
let currentSplitArray = null;
let currentAllocations = {};

function splitItem(idx, arr) {
    currentSplitIndex = idx;
    currentSplitArray = arr;
    currentAllocations = {}; // reset
    const item = arr[idx];
    $("splitItemName").textContent = `Splitting: ${item.Item || "Item"} ($${Number(item.Price || 0).toFixed(2)})`;

    // Default to quantity in item name e.g. "Beach Chair (x4)" → 4, otherwise 2
    const qtyMatch = (item.Item || "").match(/\(x(\d+)\)\s*$/i);
    const defaultQty = qtyMatch ? parseInt(qtyMatch[1], 10) : 2;
    $("splitTotalQty").value = defaultQty;
    
    renderAllocations();
    $("splitModal").classList.remove("hidden");
}

function renderAllocations() {
    const totalQty = parseInt($("splitTotalQty").value, 10) || 0;
    const container = $("splitAllocations");
    container.innerHTML = "";
    
    let sumAssigned = 0;
    const peopleKeys = ["Unassigned", ...state.people];
    
    peopleKeys.forEach(p => {
        if (currentAllocations[p] === undefined) currentAllocations[p] = 0;
    });
    
    state.people.forEach(p => { sumAssigned += currentAllocations[p] || 0; });
    
    currentAllocations["Unassigned"] = Math.max(0, totalQty - sumAssigned);
    
    peopleKeys.forEach(p => {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.marginBottom = "0.5rem";
        
        const label = document.createElement("span");
        label.textContent = p;
        label.style.color = p === "Unassigned" ? "var(--text-muted)" : "var(--text)";
        
        let inp;
        if (p === "Unassigned") {
            inp = document.createElement("input");
            inp.type = "number";
            inp.value = currentAllocations[p];
            inp.disabled = true;
            inp.style.opacity = "0.7";
        } else {
            inp = document.createElement("select");
            const maxOptions = currentAllocations[p] + currentAllocations["Unassigned"];
            for (let i = 0; i <= maxOptions; i++) {
                const opt = document.createElement("option");
                opt.value = i;
                opt.textContent = i;
                if (i === currentAllocations[p]) opt.selected = true;
                inp.appendChild(opt);
            }
            inp.addEventListener("change", (e) => {
                currentAllocations[p] = parseInt(e.target.value, 10);
                renderAllocations();
            });
        }
        
        inp.style.width = "60px";
        inp.style.padding = "0.25rem";
        inp.style.borderRadius = "4px";
        inp.style.border = "1px solid var(--border)";
        inp.style.background = "var(--bg)";
        inp.style.color = "var(--text)";
        
        row.appendChild(label);
        row.appendChild(inp);
        container.appendChild(row);
    });
    
    $("splitSaveBtn").disabled = (sumAssigned + currentAllocations["Unassigned"]) !== totalQty || totalQty < 2;
}

$("splitTotalQty").addEventListener("input", () => {
    const totalQty = parseInt($("splitTotalQty").value, 10) || 0;
    let sumAssigned = 0;
    state.people.forEach(p => sumAssigned += currentAllocations[p] || 0);
    if (totalQty < sumAssigned) {
        state.people.forEach(p => currentAllocations[p] = 0);
    }
    renderAllocations();
});

$("splitCancelBtn").addEventListener("click", () => {
    $("splitModal").classList.add("hidden");
    currentAllocations = {};
});

$("splitSaveBtn").addEventListener("click", () => {
    const totalQty = parseInt($("splitTotalQty").value, 10) || 0;
    if (totalQty < 2) return;
    const item = currentSplitArray[currentSplitIndex];
    const baseName = item.Item || "Item";
    const basePrice = Number(item.Price) || 0;
    
    saveState(() => {
        currentSplitArray.splice(currentSplitIndex, 1);
        let insertIdx = currentSplitIndex;
        
        const peopleKeys = ["Unassigned", ...state.people];
        peopleKeys.forEach(p => {
            const qty = currentAllocations[p] || 0;
            if (qty > 0) {
                const splitPrice = (qty / totalQty) * basePrice;
                currentSplitArray.splice(insertIdx++, 0, {
                    Item: `${baseName} (${qty}/${totalQty})`,
                    Price: splitPrice,
                    BelongsTo: p
                });
            }
        });
    });
    
    $("splitModal").classList.add("hidden");
    currentAllocations = {};
});

// ───────── Status helpers ─────────
function setExtractStatus(msg, kind = "") {
    const s = $("extractStatus");
    s.textContent = msg; s.className = "status" + (kind ? " " + kind : "");
}
function setUploadStatus(msg, kind = "") {
    const s = $("uploadStatus");
    s.textContent = msg; s.className = "status" + (kind ? " " + kind : "");
}

// ───────── File helpers ─────────
async function fileToBase64(file) {
    const buf = await file.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

const POLL_MAX_ATTEMPTS = 40; // ~100 seconds max
async function pollExtractJob(jobId, setStatusFn) {
    let attempts = 0;
    while (true) {
        await new Promise(r => setTimeout(r, 2500));
        attempts++;
        if (attempts > POLL_MAX_ATTEMPTS) {
            throw new Error("Extraction timed out after 100 seconds. Please try again.");
        }
        if (setStatusFn) setStatusFn(`Polling Textract (attempt ${attempts}/${POLL_MAX_ATTEMPTS})...`, "info");
        const res = await fetch(`${API_EXTRACT}/status?jobId=${jobId}`, {
            headers: { "Authorization": `Bearer ${jwtToken}` }
        });
        if (res.status === 202) {
            continue;
        }
        if (!res.ok) {
            const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(errBody.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        return data; // returns { shopName, purchaseDate, items }
    }
}

function validFile(file, setStatus) {
    if (!file) { setStatus("Please choose a file.", "error"); return false; }
    if (file.size > MAX_BYTES) {
        setStatus(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB; max 5 MB).`, "error");
        return false;
    }
    return true;
}

// ───────── AI extraction ─────────
async function extractInvoice() {
    const input = $("invoiceFile");
    const file = input.files[0];
    if (!file) return;
    await processFile(file, $("extractBtn"));
    input.value = "";
}

async function processFile(file, actionBtn = null) {
    if (!validFile(file, setExtractStatus)) return;

    if (actionBtn) actionBtn.disabled = true;
    setExtractStatus("Extracting items with AI…");

    try {
        const data_b64 = await fileToBase64(file);
        const res = await fetch(API_EXTRACT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${jwtToken}`
            },
            body: JSON.stringify({ mime_type: file.type, data_b64 }),
        });
        if (!res.ok && res.status !== 202) {
            const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(errBody.error || `HTTP ${res.status}`);
        }
        let result;
        if (res.status === 202) {
            const data = await res.json();
            result = await pollExtractJob(data.jobId, setExtractStatus);
        } else {
            result = await res.json();
        }
        
        const extractedItems = Array.isArray(result) ? result : (result.items || []);
        const extractedShopName = result.shopName || "";
        const extractedDate = result.purchaseDate || "";
        
        saveState(() => {
            if (extractedShopName) {
                state.shopName = extractedShopName;
                // Auto-set tax/discount defaults based on store name (same logic as shopName input handler)
                const isCostco = extractedShopName.trim().toLowerCase().includes("costco");
                state.includeTax  = isCostco;
                state.taxPct      = isCostco ? 3.0 : 0;
                state.discountPct = isCostco ? 20.0 : 0;
                // Sync settings UI inputs
                if ($("includeTax"))  $("includeTax").checked  = state.includeTax;
                if ($("taxPct"))      $("taxPct").value        = state.taxPct;
                if ($("discountPct")) $("discountPct").value   = state.discountPct;
                if ($("shopNameInput") && $("shopNameInput").value !== extractedShopName)
                    $("shopNameInput").value = extractedShopName;
            }
            if (extractedDate) state.purchaseDate = extractedDate;
            state.items = []; // Clear previous items on new receipt upload
            state.pending = extractedItems.map((it) => {
                const rawPrice = String(it.Price ?? "").replace(/[$,]/g, "");
                const price = parseFloat(rawPrice);
                return {
                    Item: String(it.Item ?? ""),
                    Price: isFinite(price) ? price : 0,
                    BelongsTo: state.people[0] || "Me",
                };
            });
        });
        setExtractStatus(`Extracted ${state.pending.length} item${state.pending.length === 1 ? "" : "s"}. Shop: ${extractedShopName || "None"}`, "success");
    } catch (e) {
        setExtractStatus(`Error: ${e.message}`, "error");
    } finally {
        if (actionBtn) actionBtn.disabled = false;
    }
}

// ───────── S3 upload ─────────
async function uploadToS3() {
    const file = $("s3File").files[0];
    if (!validFile(file, setUploadStatus)) return;

    const btn = $("uploadS3Btn");
    btn.disabled = true;
    setUploadStatus("Requesting upload URL…");

    try {
        const urlRes = await fetch(API_UPLOAD, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${jwtToken}`
            },
            body: JSON.stringify({ filename: file.name, content_type: file.type }),
        });
        if (!urlRes.ok) {
            const errBody = await urlRes.json().catch(() => ({ error: `HTTP ${urlRes.status}` }));
            throw new Error(errBody.error || `HTTP ${urlRes.status}`);
        }
        const { url, fields, key } = await urlRes.json();

        setUploadStatus("Uploading to S3…");
        const formData = new FormData();
        for (const [k, v] of Object.entries(fields)) {
            formData.append(k, v);
        }
        formData.append("file", file); // Must be the last field!

        const postRes = await fetch(url, {
            method: "POST",
            body: formData,
        });
        if (!postRes.ok) {
            throw new Error(`S3 upload failed (${postRes.status}).`);
        }

        saveState(() => {
            state.uploads.unshift({ key, filename: file.name, uploadedAt: Date.now() });
        });
        setUploadStatus(`Uploaded → ${key}`, "success");
        $("s3File").value = "";
    } catch (e) {
        setUploadStatus(`Error: ${e.message}`, "error");
    } finally {
        btn.disabled = false;
    }
}

// ───────── Wire up ─────────
function wire() {
    try {
    // Auth UI
    $("authForm").addEventListener("submit", handleAuthSubmit);
    $("authSwitchBtn").addEventListener("click", (e) => {
        e.preventDefault();
        isSignUp = !isSignUp;
        forgetPasswordStep = 0;
        $("authError").textContent = "";
        $("authError").style.color = "var(--danger)";
        $("authCodeSection").classList.add("hidden");
        $("authPasswordField").classList.remove("hidden");
        $("authPasswordField").querySelector("span").textContent = "Password";
        if ($("authForgotBtn")) $("authForgotBtn").style.display = isSignUp ? "none" : "block";

        if (isSignUp) {
            $("authTitle").textContent = "Sign Up";
            $("authSubmitBtn").textContent = "Sign Up";
            $("authSwitchText").textContent = "Already have an account?";
            $("authSwitchBtn").textContent = "Log In";
            if ($("authNameField")) $("authNameField").classList.remove("hidden");
        } else {
            $("authTitle").textContent = "Log In";
            $("authSubmitBtn").textContent = "Log In";
            $("authSwitchText").textContent = "Don't have an account?";
            $("authSwitchBtn").textContent = "Sign Up";
            if ($("authNameField")) $("authNameField").classList.add("hidden");
        }
    });

    if ($("authForgotBtn")) {
        $("authForgotBtn").addEventListener("click", (e) => {
            e.preventDefault();
            forgetPasswordStep = 1;
            $("authTitle").textContent = "Reset Password";
            $("authSubmitBtn").textContent = "Send Reset Code";
            $("authError").textContent = "";
            $("authPasswordField").classList.add("hidden");
            $("authForgotBtn").style.display = "none";
            $("authSwitchText").parentNode.style.display = "none";
            $("authCodeSection").classList.add("hidden");
            if ($("authNameField")) $("authNameField").classList.add("hidden");
        });
    }
    
    if ($("togglePasswordBtn")) {
        $("togglePasswordBtn").addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const pwdInput = $("authPassword");
            const icon = $("togglePasswordIcon");
            if (pwdInput.type === "password") {
                pwdInput.type = "text";
                icon.className = "fas fa-eye-slash";
            } else {
                pwdInput.type = "password";
                icon.className = "fas fa-eye";
            }
        });
    }
    
    // Profile Modal
    $("navProfileLink").addEventListener("click", openProfileModal);

    $("profileCancelBtn").addEventListener("click", () => {
        $("profileOverlay").classList.add("hidden");
    });
    
    // Close dropdown when clicking outside or clicking overlay background
    document.addEventListener("click", (e) => {
        const overlay = $("profileOverlay");
        const navLink = $("navProfileLink");
        if (overlay && navLink && !overlay.classList.contains("hidden")) {
            if ((!overlay.contains(e.target) && !navLink.contains(e.target)) || e.target === overlay) {
                overlay.classList.add("hidden");
            }
        }
    });
    
    $("profileSignOutBtn").addEventListener("click", signOut);

    if ($("profileForm")) {
        $("profileForm").addEventListener("submit", (e) => {
            e.preventDefault();
            const newName = $("profileName").value.trim();
            const newEmail = $("profileEmail").value.trim();
            if (!cognitoUser || !newName || !newEmail) return;
            
            $("profileSubmitBtn").disabled = true;
            $("profileSubmitBtn").textContent = "Saving...";
            const attrList = [
                new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'name', Value: newName }),
                new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'email', Value: newEmail })
            ];
            
            cognitoUser.updateAttributes(attrList, (err, result) => {
                $("profileSubmitBtn").disabled = false;
                $("profileSubmitBtn").textContent = "Save";
                if (err) {
                    $("profileError").textContent = err.message || JSON.stringify(err);
                    return;
                }
                $("profileSuccess").textContent = "Profile updated successfully!";
                $("profileSuccess").style.display = "block";
                $("profileError").textContent = "";
                $("navProfileLink").textContent = `Hi, ${newName}`;
                
                // Update initial values so buttons reset
                $("profileName").dataset.initialValue = newName;
                $("profileEmail").dataset.initialValue = newEmail;
                updateProfileButtons(false);
                
                if (!state.peopleEmails) state.peopleEmails = {};
                state.peopleEmails[newName] = newEmail;
                
                const oldName = $("navProfileLink").dataset.currentName || "Me";
                if (oldName !== newName && state.peopleEmails[oldName]) {
                    delete state.peopleEmails[oldName];
                }

                if (state.people[0] === oldName) {
                    state.people[0] = newName;
                    saveState(() => { renderAll(); });
                } else {
                    // Update UI immediately since email might have changed without name change
                    renderAll();
                }
                $("navProfileLink").dataset.currentName = newName;
            });
        });
    }

    function signOut(e) {
        if (e) e.preventDefault();
        $("profileOverlay").classList.add("hidden");
        if (cognitoUser) {
            const currentName = $("navProfileLink") ? $("navProfileLink").dataset.currentName || "Me" : "Me";
            cognitoUser.signOut();
            cognitoUser = null;
            jwtToken = null;
            state.items = [];
            state.pending = [];
            state.uploads = [];
            state.people = ["Me"];
            state.peopleEmails = {};
            state.history = [];  // L-2: Clear history on sign-out to prevent data leakage
            state.shopName = "";
            stateLoaded = false;
            if ($("navProfileLink")) $("navProfileLink").classList.add("hidden");
            renderAll();
            showAuth();
        }
    };
    $("logoutBtn").addEventListener("click", signOut);

    // Settings
    if ($("shopNameInput")) {
        $("shopNameInput").addEventListener("input", (e) => saveState(() => {
            state.shopName = e.target.value;
            // Auto-set default rates based on store — user can override after
            const isCostco = state.shopName.trim().toLowerCase().includes("costco");
            state.includeTax = isCostco;
            state.taxPct     = isCostco ? 3.0 : 0;
            state.discountPct = isCostco ? 20.0 : 0;
            // Sync UI inputs to reflect new defaults
            if ($("includeTax"))  $("includeTax").checked   = state.includeTax;
            if ($("taxPct"))      $("taxPct").value         = state.taxPct;
            if ($("discountPct")) $("discountPct").value    = state.discountPct;
        }));
    }
    // User can always manually edit tax/discount for any store
    $("includeTax").addEventListener("change", (e) => saveState(() => { state.includeTax = e.target.checked; }));
    $("taxPct").addEventListener("input", (e) => saveState(() => { state.taxPct = parseFloat(e.target.value) || 0; }));
    $("discountPct").addEventListener("input", (e) => saveState(() => { state.discountPct = parseFloat(e.target.value) || 0; }));

    // Wiring events
    $("addPersonForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const nm = $("personName").value;
        const em = $("personEmail").value;
        addPerson(nm, em);
        $("personName").value = "";
        $("personEmail").value = "";
    });

    $("clearAllBtn").addEventListener("click", clearAll);
    


    if ($("historyBtn")) {
        $("historyBtn").addEventListener("click", () => {
            const container = $("historyModalContainer");
            const listContainer = $("historyListContainer");
            if (!container || !listContainer) return;
            
            listContainer.innerHTML = "";
            if (!state.history || !state.history.length) {
                listContainer.innerHTML = '<p style="text-align:center; color:var(--text-muted);">No saved bills.</p>';
            } else {
                state.history.forEach(h => {
                    // Guard against malformed history entries
                    if (!h || typeof h !== 'object') return;

                    const el = document.createElement("div");
                    el.style.background = "var(--bg-card)";
                    el.style.padding = "1rem";
                    el.style.borderRadius = "8px";
                    el.style.marginBottom = "1rem";
                    el.style.border = "1px solid var(--border)";
                    
                    const peopleSubtotals = h.peopleSubtotals || {};
                    const fallbackSubtotal = Object.values(peopleSubtotals).reduce((a, b) => a + b, 0);
                    const subtotal = isFinite(h.subtotal) ? h.subtotal : fallbackSubtotal;
                    const tax = isFinite(h.tax) ? h.tax : 0;
                    const totalBill = subtotal + tax;
                    const discount = isFinite(h.discount) ? h.discount : 0;
                    const finalTotal = isFinite(h.total) ? h.total : (totalBill - discount);

                    const header = document.createElement("div");
                    header.style.display = "flex";
                    header.style.justifyContent = "space-between";
                    header.style.alignItems = "center";
                    header.style.cursor = "pointer";
                    const rawDate = new Date(h.date);
                    const d = isNaN(rawDate) ? "Unknown date" : rawDate.toLocaleString();
                    const totalDisplay = fmt(totalBill) + (discount > 0 ? ` (Pay: ${fmt(finalTotal)})` : "");
                    // Use escapeHtml on all user-supplied values to prevent XSS
                    header.innerHTML = `
                        <div>
                            <strong style="color:var(--primary); font-size:1.1rem;">${escapeHtml(h.shopName || "Unknown Shop")}</strong><br>
                            <small style="color:var(--text-muted);">${escapeHtml(d)}</small>
                        </div>
                        <div style="text-align:right;">
                            <strong style="font-size:1.1rem;">${escapeHtml(totalDisplay)}</strong><br>
                            <span style="font-size:0.8rem; color:var(--primary);"><i class="fas fa-chevron-down"></i> Details</span>
                        </div>
                    `;
                    el.appendChild(header);
                    
                    const details = document.createElement("div");
                    details.style.display = "none";
                    details.style.marginTop = "1rem";
                    details.style.borderTop = "1px solid var(--border)";
                    details.style.paddingTop = "1rem";
                    
                    let itemsHtml = '<table class="item-table" style="width:100%; text-align:left; margin-bottom:1rem;"><thead><tr><th>Item</th><th>Price</th><th>Person</th></tr></thead><tbody>';
                    const histItems = Array.isArray(h.items) ? h.items : [];
                    histItems.forEach(it => {
                        if (!it) return;
                        // Escape all user-supplied fields before inserting into HTML
                        itemsHtml += `<tr><td>${escapeHtml(it.Item || "")}</td><td>${escapeHtml(fmt(Number(it.Price) || 0))}</td><td>${escapeHtml(it.BelongsTo || "")}</td></tr>`;
                    });
                    if (!histItems.length) {
                        itemsHtml += '<tr><td colspan="3" style="color:var(--text-muted); text-align:center;">No items recorded</td></tr>';
                    }
                    itemsHtml += '</tbody></table>';
                    
                    let subtotalsHtml = '<div style="background:rgba(0,0,0,0.2); padding:1rem; border-radius:8px;">';
                    for (const [person, amt] of Object.entries(peopleSubtotals)) {
                        if (amt > 0 || person === UNASSIGNED) {
                            const share = subtotal > 0 ? (amt / subtotal) : 0;
                            const owed = finalTotal * share;
                            subtotalsHtml += `<div style="display:flex; justify-content:space-between;"><span>${escapeHtml(person)}</span><strong>${escapeHtml(fmt(owed))}</strong></div>`;
                        }
                    }
                    if (!Object.keys(peopleSubtotals).length) {
                        subtotalsHtml += '<p style="color:var(--text-muted); margin:0;">No breakdown available</p>';
                    }
                    subtotalsHtml += '</div>';
                    
                    details.innerHTML = itemsHtml + subtotalsHtml;
                    
                    const delBtn = document.createElement("button");
                    delBtn.className = "btn btn-sm btn-outline";
                    delBtn.style.color = "var(--danger)";
                    delBtn.style.borderColor = "var(--danger)";
                    delBtn.style.marginTop = "1rem";
                    delBtn.style.width = "100%";
                    delBtn.innerHTML = '<i class="fas fa-trash-alt"></i> Delete Bill';
                    delBtn.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        if (!(await confirmModal("Are you sure you want to delete this bill?"))) return;
                        saveState(() => {
                            state.history = state.history.filter(hist => hist.id !== h.id);
                        });
                        $("historyBtn").click(); // Re-render history
                    });
                    details.appendChild(delBtn);

                    el.appendChild(details);
                    
                    header.addEventListener("click", () => {
                        const isHidden = details.style.display === "none";
                        details.style.display = isHidden ? "block" : "none";
                        header.querySelector(".fa-chevron-down, .fa-chevron-up").className = isHidden ? "fas fa-chevron-up" : "fas fa-chevron-down";
                    });
                    
                    listContainer.appendChild(el);
                });
            }
            container.classList.remove("hidden");
        });
    }

    if ($("closeHistoryModal")) {
        $("closeHistoryModal").addEventListener("click", () => {
            $("historyModalContainer").classList.add("hidden");
        });
    }
    
    if ($("clearHistoryBtn")) {
        $("clearHistoryBtn").addEventListener("click", async () => {
            if (!state.history || state.history.length === 0) {
                showToast("History is already empty.", "info");
                return;
            }
            const ok = await confirmModal("Are you sure you want to delete all saved bills? This cannot be undone.");
            if (!ok) return;
            saveState(() => {
                state.history = [];
            });
            $("historyBtn").click();
            showToast("All history cleared.", "success");
        });
    }
    
    if ($("clearItemsBtn")) {
        $("clearItemsBtn").addEventListener("click", async () => {
            const ok = await confirmModal("Are you sure you want to clear all confirmed items? This will not remove pending items or S3 uploads.");
            if (!ok) return;
            saveState(() => {
                state.shopName = "";
                state.items = [];
            });
        });
    }
    


    // Tabs
    document.querySelectorAll(".tab").forEach((t) => {
        t.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
            document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
            t.classList.add("active");
            $("tab-" + t.dataset.tab).classList.add("active");
        });
    });

    // Manual Entry
    $("manualForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const name = $("manualName").value.trim();
        const price = parseFloat($("manualPrice").value);
        const belongs = $("manualBelongs").value;
        if (!name) return;
        if (!isFinite(price) || price <= 0) return;
        saveState(() => {
            state.items.push({ Item: name, Price: price, BelongsTo: belongs });
        });
        $("manualName").value = "";
        $("manualPrice").value = "";
    });

    // Actions
    $("cameraCaptureBtn").addEventListener("click", (e) => {
        e.preventDefault();
        const cam = $("cameraInput");
        if (cam) cam.click();
    });
    $("cameraInput").addEventListener("change", async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        await processFile(f, $("cameraCaptureBtn"));
        // clear the input so the same file can be reselected later
        e.target.value = "";
    });
    $("uploadS3Btn").addEventListener("click", uploadToS3);
    $("s3File").addEventListener("change", (e) => {
        const file = e.target.files[0];
        $("s3FileNameDisplay").textContent = file ? file.name : "No file selected";
    });

    $("addAllBtn").addEventListener("click", () => {
        if (!state.items.length && !state.pending.length) {
            showToast("No items to save.", "error");
            return;
        }
        saveState(() => {
            for (const it of state.pending) {
                if (!it.Item || !isFinite(it.Price) || it.Price <= 0) continue;
                state.items.push({ Item: it.Item, Price: it.Price, BelongsTo: it.BelongsTo });
            }
            state.pending = [];

            if (!state.history) state.history = [];
            
            const subtotals = Object.fromEntries(state.people.map(p => [p, 0]));
            let subtotal = 0;
            for (const it of state.items) {
                const price = Number(it.Price) || 0;
                subtotal += price;
                if (it.BelongsTo in subtotals) {
                    subtotals[it.BelongsTo] += price;
                } else {
                    subtotals[UNASSIGNED] = (subtotals[UNASSIGNED] || 0) + price;
                }
            }
            const taxRate = state.includeTax ? state.taxPct / 100 : 0;
            const tax = subtotal * taxRate;
            const discount = (subtotal + tax) * (state.discountPct / 100);
            const total = subtotal + tax - discount;
            
            state.history.unshift({
                id: Date.now().toString(),
                date: state.purchaseDate || new Date().toISOString(),
                shopName: state.shopName || "Unknown Shop",
                items: JSON.parse(JSON.stringify(state.items)),
                subtotal, tax, discount, total,
                peopleSubtotals: subtotals
            });
            
        });
        showToast("Invoice saved to history!", "success");
        setExtractStatus("Invoice finalized.", "success");
    });
    $("discardBtn").addEventListener("click", () => {
        saveState(() => { state.pending = []; });
    });
    
    $("invoiceFile").addEventListener("change", extractInvoice);

    if ($("deleteAccountBtn")) {
        $("deleteAccountBtn").addEventListener("click", async () => {
            const ok = await confirmModal("WARNING: This will permanently delete your account, your profile, and all your saved data. This action cannot be undone. Are you sure you want to proceed?");
            if (!ok) return;
            
            if (!cognitoUser || !jwtToken) return;

            try {
                $("deleteAccountBtn").textContent = "Deleting...";
                $("deleteAccountBtn").disabled = true;

                // 1. Delete DynamoDB state
                const res = await fetch(`${BASE_URL}/shopshare/api/account`, {
                    method: "DELETE",
                    headers: { "Authorization": `Bearer ${jwtToken}` }
                });

                if (!res.ok) {
                    console.error("Failed to delete backend state", await res.text());
                }

                // 2. Delete Cognito User
                // C-2: Use showToast instead of alert() for consistent UX
                cognitoUser.deleteUser((err, result) => {
                    if (err) {
                        showToast("Error deleting account: " + err.message, "error");
                        $("deleteAccountBtn").textContent = "Delete Account";
                        $("deleteAccountBtn").disabled = false;
                        return;
                    }
                    showToast("Your account and all data have been permanently deleted.", "success");
                    // Wipe local state and sign out
                    closeProfileModal();
                    signOut();
                });
            } catch (e) {
                // H-3: Replace remaining alert() with showToast for consistency
                showToast("Network error: " + e.message, "error");
                $("deleteAccountBtn").textContent = "Delete Account";
                $("deleteAccountBtn").disabled = false;
            }
        });
    }

    renderAll();
    initAuth();
    } catch (err) {
        console.error("Initialization error:", err);
        if ($("authError")) {
            $("authError").textContent = "Startup error: " + err.message;
            $("authError").style.color = "var(--danger)";
        }
    }
}

document.addEventListener("DOMContentLoaded", wire);

// Global Profile Modal functions
function openProfileModal(e, asModal = false) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const dropdown = $("profileOverlay");
    
    if (asModal) {
        dropdown.classList.remove("profile-dropdown");
        dropdown.classList.add("auth-overlay");
    } else {
        dropdown.classList.remove("auth-overlay");
        dropdown.classList.add("profile-dropdown");
    }

    // Delete Account is only accessible from the Settings 'Edit' link, not the nav dropdown
    const deleteBtn = $("deleteAccountBtn");
    if (deleteBtn) {
        deleteBtn.style.display = asModal ? "" : "none";
    }
    
    // Toggle visibility
    if (!dropdown.classList.contains("hidden")) {
        dropdown.classList.add("hidden");
        return;
    }
    
    dropdown.classList.remove("hidden");
    $("profileSuccess").style.display = "none";
    $("profileError").textContent = "";
    
    if ($("profileName")) $("profileName").dataset.initialValue = $("profileName").value.trim();
    if ($("profileEmail")) $("profileEmail").dataset.initialValue = $("profileEmail").value.trim();
    
    updateProfileButtons(false);
}

function updateProfileButtons(isModified) {
    const submitBtn = $("profileSubmitBtn");
    const cancelBtn = $("profileCancelBtn");
    if (!submitBtn || !cancelBtn) return;
    
    if (isModified) {
        submitBtn.className = "btn btn-primary w-full";
        submitBtn.style.background = "";
        submitBtn.style.color = "";
        cancelBtn.className = "btn w-full";
        cancelBtn.style.background = "var(--surface-light)";
        cancelBtn.style.color = "var(--text)";
    } else {
        submitBtn.className = "btn w-full";
        submitBtn.style.background = "var(--surface-light)";
        submitBtn.style.color = "var(--text)";
        cancelBtn.className = "btn btn-primary w-full";
        cancelBtn.style.background = "";
        cancelBtn.style.color = "";
    }
}

function checkProfileModified() {
    const nameVal = $("profileName") ? $("profileName").value.trim() : "";
    const emailVal = $("profileEmail") ? $("profileEmail").value.trim() : "";
    const initName = $("profileName") ? $("profileName").dataset.initialValue : "";
    const initEmail = $("profileEmail") ? $("profileEmail").dataset.initialValue : "";
    
    updateProfileButtons(nameVal !== initName || emailVal !== initEmail);
}

if ($("profileName")) {
    $("profileName").addEventListener("input", checkProfileModified);
}
if ($("profileEmail")) {
    $("profileEmail").addEventListener("input", checkProfileModified);
}
