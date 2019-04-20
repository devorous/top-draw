console.log("desde client.js");
proto_ws= window.location.protocol=="https:" ? "wss" : "ws"; 
//A: el proto de websocket tiene que ser seguro si el de la página es seguro

ws= new WebSocket(proto_ws+"://"+window.location.hostname);
//A: nos conectamos al mismo servidor de donde bajo la página (asi nos lo da glitch)
ws.onmessage= m => console.log("WS LLEGO",m) 

ws.onopen= () => {
ws.send("Hola!")
console.log("WS listo, envia con ws.send('mi mensaje')");
}

function enviar(msg) {
}

//========================================================
const { Component, h, render } = window.preact;

Mensajes= (props) =>
  h('div', {},
        props.mensajes.map(m => 
          h('div', {},
            h('span',{},m.de),
            h('span',{},m.texto)
          )
        )
	);

class Chat extends Component {
  state= {
    mensajes: [],
  }

  componentDidMount() {
    ws.onmessage= m => {
      console.log("WS LLEGO",m);
      this.setState({ mensajes: this.state.mensajes.push(JSON.parse(m)) });
    }
  }
  //A: cuando recibimos un mensaje lo agregamos a la lista, y asi se redibuja la UI
  
  render(props, state) {
    return h('div',{},
        h('div',{},
          h('span',{},"Apodo:"),
          h('input',{onChange: e => console.log("E",window.x=e) }),
        ),
        h(Mensajes, {mensajes: state.mensajes}),
        h('div',{},
          h('span',{},"Mensaje:"),
          h('input',{onChange: e => console.log("E",window.x=e) }),
        ),
        h('div',{},
          h('button',{onClick: e => this.enviar()}, "Enviar")
        )
    );
  }
}

render(h(Chat), document.body);