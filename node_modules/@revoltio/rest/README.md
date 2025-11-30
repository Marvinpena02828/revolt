### REST

### Features
- [X] Lightweight
- [X] Typed Response
- [X] Deno Support
- [ ] Handles Rate Limit

### Usage
```ts
import { REST } from '@revoltio/rest'

const rest = new REST()

rest.setToken('revolt-token-here')

const res = await rest.get('/')

console.log(res)
```