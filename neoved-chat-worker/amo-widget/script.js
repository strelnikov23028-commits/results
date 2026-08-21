/**
 * Виджет «Чат на сайте» для карточки сделки amoCRM.
 *
 * Ровно две кнопки: попросить клиента указать ИНН или оставить телефон.
 * Нажатие уходит в neoved-chat-worker (POST /api/ask), и у человека в чате на
 * сайте открывается нужное поле ввода — даже если раньше он ответил
 * «Не сейчас». В ленте сделки остаётся запись о запросе.
 *
 * Адрес сервиса и ключ берутся из настроек виджета, а не зашиты в код.
 */
define(['jquery'], function ($) {
  var CustomWidget = function () {
    var self = this;

    /** ID открытой сделки. У amoCRM и старых сборок разные глобальные объекты. */
    function currentLeadId() {
      var app = window.AMOCRM || window.APP;
      var card = app && app.data && app.data.current_card;
      return card && card.id ? String(card.id) : null;
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
        data: JSON.stringify({ key: cfg.key, lead_id: leadId, ask: kind, text: '' }),
      }).done(function () {
        status(kind === 'inn' ? self.i18n('status').sent_inn : self.i18n('status').sent_phone, false);
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
        '<div class="neoved-chat-panel" style="padding:12px 14px 14px">',
        '  <button type="button" class="neoved-chat-button" id="neoved-chat-inn"',
        '    style="width:100%;min-height:32px;border:0;border-radius:4px;cursor:pointer;',
        '    background:#ee0000;color:#fff;font:inherit;font-size:13px">' + i18n.ask_inn + '</button>',
        '  <button type="button" class="neoved-chat-button" id="neoved-chat-phone"',
        '    style="width:100%;min-height:32px;margin-top:8px;border:1px solid #dcdcdc;border-radius:4px;',
        '    cursor:pointer;background:#fff;color:#333;font:inherit;font-size:13px">' + i18n.ask_phone + '</button>',
        '  <p id="neoved-chat-status" style="margin:8px 0 0;font-size:11px;line-height:1.4;min-height:14px;color:#8b8b8b"></p>',
        '</div>',
      ].join('');
    }

    /**
     * Заголовок блока в панели виджетов. Без него amoCRM рисует пустую строку
     * без названия и значка: имя из manifest туда не подставляется, его нужно
     * отдать самому. Иконка — инлайновый SVG, чтобы не зависеть от того, по
     * какому пути аккаунт раздаёт картинки виджета.
     */
    function caption() {
      return [
        '<div style="display:flex;align-items:center;gap:8px">',
        '  <span style="flex:0 0 auto;width:20px;height:20px;border-radius:100px;background:#ee0000;',
        '    display:inline-flex;align-items:center;justify-content:center">',
        '    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="2.5"',
        '      stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8',
        '      8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5',
        '      0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
        '  </span>',
        '  <span>' + self.i18n('widget').name + '</span>',
        '</div>',
      ].join('');
    }

    this.callbacks = {
      render: function () {
        // Панель нужна только в карточке сделки.
        if (self.system().area !== 'lcard') return true;

        self.render_template({
          caption: {
            class_name: 'neoved-chat-widget',
            html: caption(),
          },
          body: '',
          render: template(),
        });
        return true;
      },

      init: function () {
        return true;
      },

      bind_actions: function () {
        $(document).off('.neovedChat')
          .on('click.neovedChat', '#neoved-chat-inn', function () { ask('inn'); })
          .on('click.neovedChat', '#neoved-chat-phone', function () { ask('phone'); });
        return true;
      },

      settings: function () {
        return true;
      },

      onSave: function () {
        return true;
      },

      destroy: function () {
        $(document).off('.neovedChat');
      },
    };

    return this;
  };

  return CustomWidget;
});
