/**
 * Виджет «Чат на сайте» для карточки сделки amoCRM.
 *
 * Показывает переписку с клиентом прямо в правой панели карточки и даёт
 * ответить, не переключаясь на примечания. Плюс две кнопки: запросить у
 * клиента ИНН или телефон — у человека в чате на сайте откроется поле ввода,
 * даже если раньше он ответил «Не сейчас».
 *
 * Переписка берётся из ленты сделки (neoved-chat-worker, GET /api/thread),
 * ответ уходит примечанием от имени текущего менеджера (POST /api/reply) —
 * дальше его подхватывает та же механика, что доставляет ответы клиенту.
 * Поэтому виджет одинаково работает и со сделками чата на сайте, и со
 * сделками из Telegram-канала.
 *
 * Адрес сервиса и ключ берутся из настроек виджета, а не зашиты в код.
 */
define(['jquery'], function ($) {
  var CustomWidget = function () {
    var self = this;
    var timer = null;
    var lastCount = 0;

    var REFRESH = 15000;   // как часто подтягивать новые сообщения

    /** ID открытой сделки. У amoCRM и старых сборок разные глобальные объекты. */
    function currentLeadId() {
      var app = window.AMOCRM || window.APP;
      var card = app && app.data && app.data.current_card;
      return card && card.id ? String(card.id) : null;
    }

    /** ID менеджера — от его имени пишется ответ клиенту. */
    function currentUserId() {
      if (window.AMOCRM && AMOCRM.constant) {
        var user = AMOCRM.constant('user');
        if (user && user.id) return String(user.id);
      }
      var app = window.AMOCRM || window.APP;
      return app && app.constant && app.constant('user') ? String(app.constant('user').id) : '';
    }

    function settings() {
      var s = self.get_settings() || {};
      return {
        api: String(s.api || '').replace(/\/+$/, ''),
        key: String(s.key || ''),
      };
    }

    function status(text, isError) {
      $('#neoved-chat-status').text(text || '').css('color', isError ? '#d0021b' : '#8b8b8b');
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function time(seconds) {
      if (!seconds) return '';
      var d = new Date(seconds * 1000);
      var pad = function (n) { return n < 10 ? '0' + n : String(n); };
      return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    // ─────────────────────────── переписка ───────────────────────────

    function loadThread(silent) {
      var cfg = settings();
      var leadId = currentLeadId();
      if (!cfg.api || !cfg.key || !leadId) return;

      if (!silent) status(self.i18n('status').loading, false);

      $.ajax({
        url: cfg.api + '/api/thread',
        method: 'GET',
        dataType: 'json',
        data: { key: cfg.key, lead_id: leadId },
      }).done(function (res) {
        renderThread((res && res.messages) || []);
        status('', false);
      }).fail(function (xhr) {
        var message = (xhr.responseJSON && xhr.responseJSON.error) || self.i18n('errors').thread;
        status(message, true);
      });
    }

    function renderThread(messages) {
      var i18n = self.i18n('panel');
      var $feed = $('#neoved-chat-feed');
      if (!$feed.length) return;

      if (!messages.length) {
        $feed.html('<p style="margin:0;font-size:12px;color:#9a9a9a">' + i18n.empty + '</p>');
        return;
      }

      var html = messages.map(function (m) {
        var text = escapeHtml(m.text).replace(/\n/g, '<br>');
        if (m.side === 'system') {
          return '<div style="margin:0 0 8px;padding:6px 8px;border-radius:6px;background:#f4f4f4;' +
            'font-size:11px;line-height:1.45;color:#8b8b8b;white-space:normal">' + text + '</div>';
        }
        var mine = m.side === 'manager';
        return [
          '<div style="margin:0 0 8px;display:flex;justify-content:' + (mine ? 'flex-end' : 'flex-start') + '">',
          '  <div style="max-width:88%;padding:7px 10px;border-radius:10px;font-size:12.5px;line-height:1.45;',
          '    background:' + (mine ? '#ee0000' : '#f0f0f0') + ';color:' + (mine ? '#fff' : '#333') + '">',
          '    <span style="display:block;font-size:10px;opacity:.7;margin-bottom:2px">',
          '      ' + (mine ? i18n.manager : i18n.client) + ' · ' + time(m.at) + '</span>',
          '    ' + text,
          '  </div>',
          '</div>',
        ].join('');
      }).join('');

      $feed.html(html);

      // Прокручиваем к последнему сообщению только когда их стало больше:
      // иначе фоновое обновление дёргало бы ленту под руками у менеджера.
      if (messages.length !== lastCount) {
        lastCount = messages.length;
        $feed.scrollTop($feed.prop('scrollHeight'));
      }
    }

    function sendReply() {
      var cfg = settings();
      var leadId = currentLeadId();
      var userId = currentUserId();
      var $input = $('#neoved-chat-reply');
      var text = String($input.val() || '').trim();

      if (!text) return;
      if (!cfg.api || !cfg.key) return status(self.i18n('errors').no_settings, true);
      if (!leadId) return status(self.i18n('errors').no_lead, true);
      if (!userId) return status(self.i18n('errors').no_user, true);

      $('#neoved-chat-send').prop('disabled', true);
      status(self.i18n('status').sending, false);

      $.ajax({
        url: cfg.api + '/api/reply',
        method: 'POST',
        contentType: 'application/json',
        dataType: 'json',
        data: JSON.stringify({ key: cfg.key, lead_id: leadId, user_id: userId, text: text }),
      }).done(function () {
        $input.val('');
        status(self.i18n('status').sent, false);
        loadThread(true);
      }).fail(function (xhr) {
        var message = (xhr.responseJSON && xhr.responseJSON.error) || self.i18n('errors').failed;
        status(message, true);
      }).always(function () {
        $('#neoved-chat-send').prop('disabled', false);
      });
    }

    // ─────────────────── запросить ИНН или телефон ───────────────────

    function ask(kind) {
      var cfg = settings();
      var leadId = currentLeadId();

      if (!cfg.api || !cfg.key) return status(self.i18n('errors').no_settings, true);
      if (!leadId) return status(self.i18n('errors').no_lead, true);

      var $buttons = $('.neoved-chat-button');
      $buttons.prop('disabled', true);
      status(self.i18n('status').sending, false);

      $.ajax({
        url: cfg.api + '/api/ask',
        method: 'POST',
        contentType: 'application/json',
        dataType: 'json',
        data: JSON.stringify({
          key: cfg.key,
          lead_id: leadId,
          ask: kind,
          text: String($('#neoved-chat-reply').val() || '').trim(),
        }),
      }).done(function () {
        $('#neoved-chat-reply').val('');
        status(kind === 'inn' ? self.i18n('status').sent_inn : self.i18n('status').sent_phone, false);
        loadThread(true);
      }).fail(function (xhr) {
        var message = (xhr.responseJSON && xhr.responseJSON.error) || self.i18n('errors').failed;
        status(message, true);
      }).always(function () {
        $buttons.prop('disabled', false);
      });
    }

    /** Разметка панели. Своей CSS у виджета нет — стили инлайновые. */
    function template() {
      var i18n = self.i18n('panel');
      return [
        '<div class="neoved-chat-panel" style="padding:10px 14px 14px">',
        '  <div id="neoved-chat-feed" style="max-height:260px;overflow-y:auto;padding:4px 2px 2px;margin-bottom:10px"></div>',
        '  <textarea id="neoved-chat-reply" rows="2" placeholder="' + i18n.reply + '"',
        '    style="width:100%;padding:8px 10px;border:1px solid #dcdcdc;border-radius:6px;',
        '    font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box"></textarea>',
        '  <div style="display:flex;gap:6px;margin-top:8px">',
        '    <button type="button" id="neoved-chat-send"',
        '      style="flex:1;min-height:30px;border:0;border-radius:4px;cursor:pointer;',
        '      background:#ee0000;color:#fff;font:inherit;font-size:12.5px">' + i18n.send + '</button>',
        '    <button type="button" id="neoved-chat-refresh" title="' + i18n.refresh + '"',
        '      style="min-height:30px;padding:0 10px;border:0;border-radius:4px;cursor:pointer;',
        '      background:#f0f0f0;color:#555;font:inherit;font-size:12.5px">↻</button>',
        '  </div>',
        '  <div style="display:flex;gap:6px;margin-top:6px">',
        '    <button type="button" class="neoved-chat-button" id="neoved-chat-inn"',
        '      style="flex:1;min-height:28px;border:1px solid #dcdcdc;border-radius:4px;cursor:pointer;',
        '      background:#fff;color:#333;font:inherit;font-size:12px">' + i18n.ask_inn + '</button>',
        '    <button type="button" class="neoved-chat-button" id="neoved-chat-phone"',
        '      style="flex:1;min-height:28px;border:1px solid #dcdcdc;border-radius:4px;cursor:pointer;',
        '      background:#fff;color:#333;font:inherit;font-size:12px">' + i18n.ask_phone + '</button>',
        '  </div>',
        '  <p id="neoved-chat-status" style="margin:8px 0 0;font-size:11px;line-height:1.4;min-height:14px;color:#8b8b8b"></p>',
        '</div>',
      ].join('');
    }

    this.callbacks = {
      render: function () {
        // Панель нужна только в карточке сделки.
        if (self.system().area !== 'lcard') return true;

        self.render_template({
          caption: { class_name: 'neoved-chat-widget' },
          body: '',
          render: template(),
        });
        return true;
      },

      init: function () {
        if (self.system().area !== 'lcard') return true;
        loadThread(false);
        if (timer) clearInterval(timer);
        timer = setInterval(function () { loadThread(true); }, REFRESH);
        return true;
      },

      bind_actions: function () {
        $(document).off('.neovedChat')
          .on('click.neovedChat', '#neoved-chat-inn', function () { ask('inn'); })
          .on('click.neovedChat', '#neoved-chat-phone', function () { ask('phone'); })
          .on('click.neovedChat', '#neoved-chat-send', sendReply)
          .on('click.neovedChat', '#neoved-chat-refresh', function () { loadThread(false); })
          .on('keydown.neovedChat', '#neoved-chat-reply', function (e) {
            // Enter отправляет, Shift+Enter переносит строку — как в мессенджерах.
            if (e.keyCode === 13 && !e.shiftKey) {
              e.preventDefault();
              sendReply();
            }
          });
        return true;
      },

      settings: function () {
        return true;
      },

      onSave: function () {
        return true;
      },

      destroy: function () {
        if (timer) clearInterval(timer);
        $(document).off('.neovedChat');
      },
    };

    return this;
  };

  return CustomWidget;
});
