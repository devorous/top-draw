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

//========================================================
const { Component, h, render } = window.preact;

class Mensajes extends Component {
  state= {
    mensajes: []
  }

  actualizarMensajes(msg) {
    this.setState({mensajes: msg});
  }

	render(props, state) {
		return (
			h('div', {},
        state.mensajes.map(m => 
          h('div', {},
            h('span',{},m.de),
            h('span',{},m.texto)
          )
        )
			)
		);
	}
}

var msg_cmp;

render(h('div',{},
      h('div',{},
        h('span',{},"Apodo:"),
        h('input',{onChange: e => console.log("E",x=e) }),
      ),
      XX= h('Mensajes', { ref: cmp => (msg_cmp= cmp) }),
      h('div',{},
        h('span',{},"Mensaje:"),
        h('input',{onChange: e => console.log("E",x=e) }),
      ),
      h('div',{},
        h('button',{onClick: e => enviar()}, "Enviar")
      )
) , document.body);