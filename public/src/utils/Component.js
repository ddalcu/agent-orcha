
export class Component extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
        this.postRender();
    }

    render() {
        this.innerHTML = this.template();
    }

    postRender() {
        // Override for event listeners etc.
    }

    template() {
        return '<div></div>';
    }
}
