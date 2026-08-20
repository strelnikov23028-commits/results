/**
 * Виджет «Чат на сайте» для карточки сделки amoCRM.
 *
 * Даёт менеджеру две кнопки: запросить у клиента ИНН или телефон. Нажатие
 * уходит в neoved-chat-worker (POST /api/ask), тот кладёт событие в очередь
 * сделки — и у человека в чате на сайте открывается нужное поле ввода, даже
 * если раньше он ответил «Не сейчас».
 *
 * Адрес сервиса и ключ берутся из настроек виджета, а не зашиты в код:
 * архив можно передавать как есть.
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

    function notify(text, isError) {
      if (window.AMOCRM && AMOCRM.notifications) {
        AMOCRM.notifications.show_message({ header: self.i18n('widget').name, text: text });
      }
      var $status = $('#neoved-chat-status');
      $status.text(text).css('color', isError ? '#d0021b' : '#54a271');
    }

    function ask(kind) {
      var cfg = settings();
      var leadId = currentLeadId();

      if (!cfg.api || !cfg.key) return notify(self.i18n('errors').no_settings, true);
      if (!leadId) return notify(self.i18n('errors').no_lead, true);

      var $buttons = $('.neoved-chat-button');
      $buttons.prop('disabled', true);
      notify(self.i18n('status').sending, false);

      $.ajax({
        url: cfg.api + '/api/ask',
        method: 'POST',
        contentType: 'application/json',
        dataType: 'json',
        data: JSON.stringify({
          key: cfg.key,
          lead_id: leadId,
          ask: kind,
          text: String($('#neoved-chat-comment').val() || '').trim(),
        }),
      }).done(function () {
        $('#neoved-chat-comment').val('');
        notify(kind === 'inn' ? self.i18n('status').sent_inn : self.i18n('status').sent_phone, false);
      }).fail(function (xhr) {
        var message = (xhr.responseJSON && xhr.responseJSON.error) || self.i18n('errors').failed;
        notify(message, true);
      }).always(function () {
        $buttons.prop('disabled', false);
      });
    }

    /** Разметка панели. Стили инлайновые: своей CSS у виджета нет. */
    function template() {
      var i18n = self.i18n('panel');
      return [
        '<div class="neoved-chat-panel" style="padding:12px 16px 16px">',
        '  <p style="margin:0 0 10px;font-size:13px;line-height:1.45;color:#7a7a7a">' + i18n.hint + '</p>',
        '  <textarea id="neoved-chat-comment" rows="2" placeholder="' + i18n.comment + '"',
        '    style="width:100%;padding:8px 10px;border:1px solid #dcdcdc;border-radius:6px;',
        '    font:inherit;font-size:13px;resize:vertical;box-sizing:border-box"></textarea>',
        '  <div style="display:flex;gap:8px;margin-top:10px">',
        '    <button type="button" class="neoved-chat-button" id="neoved-chat-inn"',
        '      style="flex:1;min-height:32px;border:0;border-radius:4px;cursor:pointer;',
        '      background:#ee0000;color:#fff;font:inherit;font-size:13px">' + i18n.ask_inn + '</button>',
        '    <button type="button" class="neoved-chat-button" id="neoved-chat-phone"',
        '      style="flex:1;min-height:32px;border:0;border-radius:4px;cursor:pointer;',
        '      background:#f0f0f0;color:#333;font:inherit;font-size:13px">' + i18n.ask_phone + '</button>',
        '  </div>',
        '  <p id="neoved-chat-status" style="margin:10px 0 0;font-size:12px;line-height:1.4;min-height:16px"></p>',
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
        return true;
      },

      bind_actions: function () {
        $(document).off('click.neovedChat').on('click.neovedChat', '#neoved-chat-inn', function () {
          ask('inn');
        }).on('click.neovedChat', '#neoved-chat-phone', function () {
          ask('phone');
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
        $(document).off('click.neovedChat');
      },
    };

    return this;
  };

  return CustomWidget;
});
