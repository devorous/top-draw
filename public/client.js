console.log("desde client.js");
proto_ws= window.location.protocol=="https:" ? "wss" : "ws"; 
//A: el proto de websocket tiene que ser seguro si el de la página es seguro

ws= new WebSocket(proto_ws+"://"+window.location.hostname);
//A: nos conectamos al mismo servidor de donde bajo la página (asi nos lo da glitch)
ws.onmessage= m => console.log("WS LLEGO",m) 

ws.onopen= () => {
ws.send(JSON.stringify({m: "anonimo", texto: "hola!"}));
console.log("WS listo, envia con ws.send('mi mensaje')");
}

function enviar(msg) {
}

//========================================================
const { Component, h, render } = window.preact;

Mensajes= (props,state) =>
  h('div', {},
        props.mensajes.map(m => 
          h('div', {},
            h('span',{style: "display: inline-block; width: 15em"},m.de),
            h(':'),
            h('span',{},m.texto)
          )
        )
	);

class Chat extends Component {
  state= {
    mensajes: [],
  }
  apodo_el= null; //U: el elemento donde esta el apodo
  mensaje_el= null; //U: el elemento donde está el mensaje

  componentDidMount() {
    ws.onmessage= m => {
      console.log("WS LLEGO",m);
      this.state.mensajes.push(JSON.parse(m.data))
      this.setState({ mensajes: this.state.mensajes });
    }
  }
  //A: cuando recibimos un mensaje lo agregamos a la lista, y asi se redibuja la UI
  
  enviar() {
    var apodo= this.apodo_el.value || 'anonimo';
    var msj= this.mensaje_el.value;
    if (!msj) { alert("Escribi un mensaje!") }
    else {
      ws.send(JSON.stringify({de: apodo, texto: msj}));
    }
  }

  render(props, state) {
    return h('div',{},
        h('div',{},
          h('span',{},"Apodo:"),
          h('input',{ ref: e => (this.apodo_el=e) }),
        ),
        h(Mensajes, {mensajes: state.mensajes}),
        h('div',{},
          h('span',{},"Mensaje:"),
          h('input',{ref: e => (this.mensaje_el=e)}),
        ),
        h('div',{},
          h('button',{onClick: e => this.enviar()}, "Enviar")
        )
    );
  }
}

render(h(Chat), document.body);