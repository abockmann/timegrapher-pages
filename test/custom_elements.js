class SettingsMenu extends HTMLElement {

    static observedAttributes = ["label", "value"];

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
        this.style.display = 'block';
        this.settings = [];
        this.data = {};
        this.hide();
        this.render();
    }

    render() {
        this.shadowRoot.innerHTML = `
            <link rel="stylesheet" href="style.css" type="text/css">
            <div class="settings-menu">
                <div class="settings-menu-content" id="settings-menu-content">
                    <!-- items get injected here -->
                </div>
            </div>
        `;
    }

    updateContent() {
        const content = this.shadowRoot.getElementById('settings-menu-content');
        content.innerHTML = this.settings
            .map(setting => {
                const value = this.data[setting.key];
                const displayValue = value + (setting.suffix || '');
                // data-key below is a way of adding data to an element.  It can be retrieved by element.dataset.key in JS (as is done below)
                return `
                    <div class="settings-item" data-key="${setting.key}">
                        <span class="label">${setting.label}</span>
                        <span class="value">${displayValue}</span>
                        ${setting.hasWidget ? '<span class="arrow">❯</span>' : ''}
                    </div>
                `;
            }).join('');

        // select all elements with class settings-item, and assign click event listeners to them.  When they're clicked; dispatch custom events with information about what's clicked, and its value
        content.querySelectorAll('.settings-item').forEach(item => {
          item.addEventListener('click', () => {
            const key = item.dataset.key;
            const setting = this.settings.find(s => s.key === key); // find the setting that match the key
            if (setting && setting.hasWidget) {
              this.dispatchEvent( // When settings item clicked; dispatch a custom event, with information about what's clicked, and its value (to be shown in the widget) 
                new CustomEvent('setting-clicked', {
                  detail: {
                    settingKey: key,
                    currentValue: this.data[key]
                  }
                })
              );
            }
          });
        });

    }

    // call with a list of settings (each item is a dict with key, label, hasWidget and suffix) to populate the settings menu.  This will not include values
    configure(settingsConfig) {
        this.settings = settingsConfig;
        this.updateContent(); // Update content after configuration
    }

    // requires configure to have been run first.  Will populate the settings menu with values.
    refreshSettingsValues(data) {
        this.data = data;
        this.updateContent();
    }

    hide() {
        this.style.display = 'none';
    }

    show() {
        this.style.display = 'block';
    }

    getData() {
        return this.data;
    }
}

// Register the settings menu item element so that it can be used
customElements.define('settings-menu', SettingsMenu);


// Widget container (to host widgets)


class WidgetContainer extends HTMLElement {
    constructor() { 
        super(); 
        this.attachShadow({ mode: 'open' }); 
        this.currentWidget = null; 
        this.render(); 
    }
    
    render() {
    this.shadowRoot.innerHTML = `
        <style>
        .container {
            position:fixed;
            top:50%;
            left:50%;
            transform:translate(-50%,-50%);
            z-index:1001;
            display:none
        }

        .container.visible {
           display:block
        }
        </style>
        <div class="container" id="container"></div>`;
    }
    
    configureWidgets(config) {
        this.widgetsConfig = config;
    }


    showWidget(widgetName, currentValue, valueChangeCallback, backCallback) {
        const container = this.shadowRoot.getElementById('container');
        container.innerHTML = '';
        const config = this.widgetsConfig[widgetName];


        let widget;
        switch (config.type) {
            case 'preset':
            widget = document.createElement('drag-widget');
            break;
            case 'drag':
            widget = document.createElement('drag-widget');
            break;
            case 'select':
            widget = document.createElement('select-widget');
            break;
            default:
            return;
        }


        widget.configure(widgetName, config);
        widget.setValue(currentValue);
        widget.addEventListener('value-changed', e => valueChangeCallback(e.detail.value));
        widget.addEventListener('back-clicked', () => backCallback());
        container.appendChild(widget);
        container.classList.add('visible');
        this.currentWidget = widget;
    }

    hide() { 
        const c = this.shadowRoot.getElementById('container'); 
        c.classList.remove('visible'); 
        c.innerHTML = ''; 
        this.currentWidget = null; 
    }

    isVisible() {
        return this.currentWidget !== null;
    }
}

customElements.define('widget-container', WidgetContainer);


// Base class for widgets

class BaseWidget extends HTMLElement {
    constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.config = null;
    this.widgetName = null;
    this.value = null;
    }

    configure(widgetName, config) {
    this.widgetName = widgetName;
    this.config = config;
    this.value = config.defaultValue;
    }

    setValue(value) {
    this.value = value;
    if (this.shadowRoot.innerHTML) {
        this.updateDisplay();
    } else {
        this.render();
    }
    }

    updateDisplay() {
    // to be overridden
    }

    emitChange() {
    this.dispatchEvent(
        new CustomEvent('value-changed', {
        detail: { value: this.value }
        })
    );
    }

    emitBackClick() {
    this.dispatchEvent(new CustomEvent('back-clicked'));
    }

    getDisplayValue() {
    return this.value + (this.config.suffix || '');
    }

    getTitle() {
    return this.config.label.toUpperCase();
    }
}

// Drag widget


class DragWidget extends BaseWidget {
    render() {
    this.list = this.config.presets || this.config.options || null;
    this.stepPx = this.list ? (this.config.sensitivity||20) : null;
    this.shadowRoot.innerHTML = `
        <link rel="stylesheet" href="style.css" type="text/css">
        <div class="widget">
        <div class="title">${this.getTitle()}</div>
        <div class="value-display swipe-to-set" id="value">${this.getDisplayValue()}</div>
        <div class="drag-hint">Drag up/down to adjust</div>
        <button class="back-btn" id="back">← BACK</button>
        </div>`;
    this.setupEventListeners();
    }
    setupEventListeners() {
    const backBtn = this.shadowRoot.getElementById('back');
    const valueDisplay = this.shadowRoot.getElementById('value');
    backBtn.addEventListener('click', () => this.emitBackClick());
    this.setupDragHandling(valueDisplay);
    }
    setupDragHandling(el) {
    let dragging=false,startY=0,startVal=0,startIndex=0;
    const list=this.list;
    const startDrag = y=>{
        dragging=true; startY=y; startVal=this.value;
        if(list){ startIndex=list.indexOf(startVal); }
        el.style.borderColor='var(--border-active)';
    };
    const updateDrag=y=>{
        if(!dragging) return;
        const diff = startY - y;
        if(list){
        const steps = Math.round(diff / this.stepPx);
        let idx = startIndex + steps;
        idx = Math.max(0, Math.min(list.length-1, idx));
        this.value = list[idx];
        } else {
        let change = diff * this.config.sensitivity;
        let newVal = startVal + change;
        newVal = Math.max(this.config.range.min, Math.min(this.config.range.max, newVal));
        if(this.config.precision!==undefined) newVal = parseFloat(newVal.toFixed(this.config.precision));
        else if(Number.isInteger(this.config.defaultValue)) newVal = Math.round(newVal);
        this.value=newVal;
        }
        this.updateDisplay(); this.emitChange();
    };
    const endDrag=()=>{dragging=false;el.style.borderColor='transparent'};
    el.addEventListener('mousedown',e=>{e.preventDefault();startDrag(e.clientY)});
    document.addEventListener('mousemove',e=>{if(dragging){e.preventDefault();updateDrag(e.clientY)}});
    document.addEventListener('mouseup',endDrag);
    el.addEventListener('touchstart',e=>{e.preventDefault();startDrag(e.touches[0].clientY)});
    el.addEventListener('touchmove',e=>{e.preventDefault();updateDrag(e.touches[0].clientY)});
    el.addEventListener('touchend',endDrag);
    }
    updateDisplay() {
    const vd = this.shadowRoot.getElementById('value');
    if(vd) vd.textContent = this.getDisplayValue();
    }
    getDisplayValue() {
    if (this.config.precision !== undefined) {
        return this.value.toFixed(this.config.precision) + (this.config.suffix || '');
    }
    return this.value + (this.config.suffix || '');
    }
}
customElements.define('drag-widget', DragWidget);


    
class SelectWidget extends BaseWidget {
    render() {
    this.shadowRoot.innerHTML = `
        <link rel="stylesheet" href="style.css" type="text/css">
        <div class="widget">
        <div class="title">${this.getTitle()}</div>
        <div id="options">
            ${this.config.options
            .map(
                (option) => `
            <div class="option text-left-align" data-value="${option}">${option}</div>
            `
            )
            .join('')}
        </div>
        <button class="back-btn" id="back">← BACK</button>
        </div>
    `;
    this.setupEventListeners();
    this.updateSelection();
    }

    setupEventListeners() {
    const options = this.shadowRoot.querySelectorAll('.option');
    const backBtn = this.shadowRoot.getElementById('back');
    options.forEach((option) => {
        option.addEventListener('click', () => {
        this.value = option.dataset.value;
        this.updateSelection();
        this.emitChange();
        });
    });
    backBtn.addEventListener('click', () => this.emitBackClick());
    }

    updateSelection() {
    const options = this.shadowRoot.querySelectorAll('.option');
    options.forEach((option) => {
        if (option.dataset.value === this.value) {
        option.classList.add('selected');
        } else {
        option.classList.remove('selected');
        }
    });
    }
}
customElements.define('select-widget', SelectWidget);