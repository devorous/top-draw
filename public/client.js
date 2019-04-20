console.log("desde client.js");
proto_ws= window.location.protocol=="https:" ? "wss" : "ws"; 
//A: el proto de websocket tiene que ser seguro si el de la página es seguro

ws= new WebSocket(proto_ws+"://"+window.location.hostname);
//A: nos conectamos al mismo servidor de donde bajo la página (asi nos lo da glitch)
ws.onmessage= m => console.log("WS LLEGO",m) 

ws.onopen= () => {
ws.send(JSON.stringify({de: "anonimo", texto: "hola!"}));
console.log("WS listo, envia con ws.send('mi mensaje')");
}

function enviar(msg) {
}

//========================================================
function inventarApodo() {
  return Array(3).fill('_').map( x => (
  String.fromCharCode("a".charCodeAt(0)+Math.floor(25*Math.random())) +
  "aeiou"[Math.floor(Math.random()*5)]
  )).join('');
}

//========================================================
const { Component, h, render } = window.preact;

Mensajes= (props,state) =>
  h('div', {},
        props.mensajes.map(m => 
          h('div', {},
            h('span',{style: "display: inline-block; width: 5em"},m.de),
            h(':'),
            h('span',{},m.texto)
          )
        )
	);

class Chat extends Component {
  state= {
    apodo: inventarApodo(),
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
    var apodo= this.state.apodo || 'anonimo';
    var msj= this.state.mensaje;
    if (!msj) { alert("Escribi un mensaje!") }
    else {
      ws.send(JSON.stringify({de: apodo, texto: msj}));
      this.setState({ mensaje: '' });
    }
  }

  render(props, state) {
    return h('div',{},
        h('div',{},
          h('span',{},"Apodo:"),
          h('input',{ onInput: e => { this.setState({ apodo: e.target.value })}, value: this.state.apodo }),
        ),
        h(Mensajes, {mensajes: state.mensajes}),
        h('div',{},
          h('span',{},"Mensaje:"),
          h('input',{
            onInput: e => { this.setState({ mensaje: e.target.value })}, 
            value: this.state.mensaje,
            onKeyUp: e => { if (e.key=="Enter") { this.enviar() } } 
          }),
        ),
        h('div',{},
          h('button',{onClick: e => this.enviar()}, "Enviar")
        )
    );
  }
}

render(h(Chat), document.body);