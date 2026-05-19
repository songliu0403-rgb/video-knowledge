export const consoleClientScript = String.raw`
(() => {
  const flash = document.querySelector('[data-flash]');
  const manualOutput = document.querySelector('[data-manual-output]');
  const searchInput = document.querySelector('[data-console-filter]');
  const highlightClass = 'entity-card-highlight';
  const guidedFormClass = 'guided-form-highlight';

  const highlightEntity = (targetRef) => {
    if (!targetRef) return;

    const entity = document.querySelector('[data-entity-ref="' + CSS.escape(targetRef) + '"]');
    if (!(entity instanceof HTMLElement)) return;

    entity.classList.add(highlightClass);
    entity.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => entity.classList.remove(highlightClass), 2200);
  };

  const findFormByRef = (formRef) => {
    if (!formRef) return null;
    const form = document.querySelector('[data-form-ref="' + CSS.escape(formRef) + '"]');
    return form instanceof HTMLFormElement ? form : null;
  };

  const applyPrefill = (form, prefill) => {
    if (!form || !prefill || typeof prefill !== 'object') return;

    Object.entries(prefill).forEach(([name, value]) => {
      if (value === undefined || value === null) return;
      const field = form.querySelector('[name="' + CSS.escape(name) + '"]');
      if (
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
      ) {
        field.value = String(value);
      }
    });
  };

  const focusFormField = (formRef, focusField, prefillRaw) => {
    const form = findFormByRef(formRef);
    if (!form) return;

    let parsedPrefill;
    if (prefillRaw) {
      try {
        parsedPrefill = parseJsonField(prefillRaw, '预填数据');
      } catch (error) {
        console.warn(error);
      }
    }

    applyPrefill(form, parsedPrefill);
    form.classList.add(guidedFormClass);
    window.setTimeout(() => form.classList.remove(guidedFormClass), 2200);

    const field = focusField
      ? form.querySelector('[name="' + CSS.escape(focusField) + '"]')
      : null;

    form.scrollIntoView({ behavior: 'smooth', block: 'center' });

    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement ||
      field instanceof HTMLSelectElement
    ) {
      field.focus({ preventScroll: true });
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        field.select();
      }
    }
  };

  const persistRepairIntent = (targetRef, formRef, focusField, prefillRaw) => {
    if (!targetRef && !formRef) return;

    try {
      window.sessionStorage.setItem(
        'acp-repair-intent',
        JSON.stringify({
          targetRef,
          formRef,
          focusField,
          prefillRaw,
        }),
      );
    } catch {}
  };

  const setFlash = (message, tone = 'info') => {
    if (!flash) return;
    flash.textContent = message;
    flash.dataset.tone = tone;
  };

  const readResponse = async (response) => {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const parseJsonField = (rawValue, fieldName) => {
    const value = String(rawValue ?? '').trim();
    if (!value) return undefined;
    try {
      return JSON.parse(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown JSON error.';
      throw new Error(fieldName + ' 不是合法 JSON: ' + message);
    }
  };

  const submitAction = async ({ url, method, body }) => {
    const response = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await readResponse(response);
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && payload.error && typeof payload.error.message === 'string'
          ? payload.error.message
          : '请求失败';
      throw new Error(message);
    }
    return payload;
  };

  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const button = target.closest('[data-api-action]');
    if (!(button instanceof HTMLButtonElement)) return;

    const url = button.dataset.apiAction;
    const method = button.dataset.apiMethod || 'POST';
    const confirmMessage = button.dataset.confirmMessage;
    if (!url) return;
    if (confirmMessage && !window.confirm(confirmMessage)) return;

    button.disabled = true;
    setFlash('正在执行操作...', 'blue');

    try {
      const body = button.dataset.agentEnabled
        ? { agentEnabled: button.dataset.agentEnabled === 'true' }
        : button.dataset.apiBody
          ? parseJsonField(button.dataset.apiBody, '动作负载')
          : undefined;
      const targetRef = button.dataset.scrollTarget;
      persistRepairIntent(targetRef, button.dataset.formRef, button.dataset.focusField, button.dataset.prefill);
      await submitAction({ url, method, body });
      setFlash('操作完成，正在刷新控制台。', 'green');
      window.setTimeout(() => window.location.reload(), 220);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      setFlash(message, 'red');
      button.disabled = false;
    }
  });

  document.querySelectorAll('form[data-api-form]').forEach((node) => {
    node.addEventListener('submit', async (event) => {
      event.preventDefault();

      const form = event.currentTarget;
      if (!(form instanceof HTMLFormElement)) return;

      const url = form.dataset.apiForm;
      const method = form.dataset.apiMethod || 'POST';
      const kind = form.dataset.formKind || 'generic';
      const formData = new FormData(form);

      try {
        let body;

        if (kind === 'connector-create') {
          body = {
            connectorId: String(formData.get('connectorId') || '').trim(),
            connectorType: String(formData.get('connectorType') || '').trim(),
            title: String(formData.get('title') || '').trim() || undefined,
            config: parseJsonField(formData.get('configJson'), '连接器配置'),
          };
        } else if (kind === 'connector-update') {
          body = {
            title: String(formData.get('title') || '').trim() || undefined,
            enabled: String(formData.get('enabled') || '').trim()
              ? String(formData.get('enabled')) === 'true'
              : undefined,
            config: parseJsonField(formData.get('configJson'), '连接器配置'),
          };
        } else if (kind === 'runtime-install' || kind === 'runtime-relink') {
          const binaryPath = String(formData.get('binaryPath') || '').trim();
          const installPath = String(formData.get('installPath') || '').trim();
          body = {
            ...(binaryPath ? { binaryPath } : {}),
            ...(installPath ? { installPath } : {}),
            version: String(formData.get('version') || '').trim() || undefined,
          };
        } else if (kind === 'manual-execute') {
          body = {
            capabilityId: String(formData.get('capabilityId') || '').trim(),
            input: parseJsonField(formData.get('inputJson'), '能力输入') || {},
            context: {
              caller: String(formData.get('caller') || '').trim() || 'manual-console',
            },
          };
        } else {
          body = Object.fromEntries(formData.entries());
        }

        setFlash(kind === 'manual-execute' ? '正在执行能力...' : '正在提交操作...', 'blue');
        const payload = await submitAction({ url, method, body });

        if (kind === 'manual-execute') {
          if (manualOutput) {
            manualOutput.textContent = JSON.stringify(payload, null, 2);
          }
          setFlash('手动调用完成。', 'green');
          return;
        }

        setFlash('操作完成，正在刷新控制台。', 'green');
        window.setTimeout(() => window.location.reload(), 220);
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        setFlash(message, 'red');
      }
    });
  });

  if (searchInput instanceof HTMLInputElement) {
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.trim().toLowerCase();
      document.querySelectorAll('[data-filter-card]').forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const haystack = (node.dataset.search || '').toLowerCase();
        node.style.display = !query || haystack.includes(query) ? '' : 'none';
      });
    });
  }

  document.querySelectorAll('[data-scroll-target]').forEach((node) => {
    node.addEventListener('click', (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLElement)) return;

      const targetRef = target.dataset.scrollTarget;
      const href = target.getAttribute('href');

      if (targetRef && !target.hasAttribute('data-api-action')) {
        event.preventDefault();
        if (href && href.startsWith('#')) {
          history.replaceState(null, '', href);
        }
        highlightEntity(targetRef);
        focusFormField(target.dataset.formRef, target.dataset.focusField, target.dataset.prefill);
      }
    });
  });

  if (flash) {
    flash.textContent = '';
    delete flash.dataset.tone;
  }

  try {
    const persistedIntent = window.sessionStorage.getItem('acp-repair-intent');
    if (persistedIntent) {
      window.sessionStorage.removeItem('acp-repair-intent');
      const intent = JSON.parse(persistedIntent);
      window.setTimeout(() => {
        if (intent && typeof intent === 'object') {
          highlightEntity(intent.targetRef);
          focusFormField(intent.formRef, intent.focusField, intent.prefillRaw);
        }
      }, 120);
    }
  } catch {}
})();
`;
