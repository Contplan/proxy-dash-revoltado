# Proxy Dash Revoltado

Este proxy hospeda uma função Edge da Vercel (`/api/proxy`) que encaminha as requisições
para o webhook configurado em `TARGET_URL` e adiciona recursos de paginação quando
parâmetros de página e limite são enviados.

## Como fazer uma requisição com paginação

Envie uma chamada `GET` para a função com os parâmetros `page` e `limit` (ou qualquer um
dos aliases suportados). Exemplo:

```
GET https://seu-projeto.vercel.app/api/proxy?page=2&limit=50&status=ativo
```

* `page` (obrigatório para habilitar paginação): número da página desejada. O valor mínimo é `1`.
* `limit` (ou `per_page`, `page_size`, `pageSize`): quantidade de itens por página. O valor padrão
  é `100` e o máximo permitido é `1000`.
* Quaisquer outros parâmetros de query (`status=ativo` no exemplo) são encaminhados
  normalmente para o webhook.

Quando a resposta do webhook é um array JSON (ou um objeto contendo um campo `data` que é
array), o proxy retorna um JSON no formato:

```json
{
  "data": ["itens da página"],
  "pagination": {
    "page": 2,
    "pageSize": 50,
    "totalItems": 1234,
    "totalPages": 25
  }
}
```

Além do campo `data`, o proxy também consegue localizar automaticamente arrays em outras
estruturas comuns (`items`, `records`, `rows`, `result`, `results`, etc.) ou mesmo em
objetos aninhados. Dessa forma ele consegue fatiar a maioria das respostas com grandes
volumes sem precisar alterar o backend. Caso nenhum array seja encontrado no corpo JSON,
o proxy devolve a resposta original.

Se nenhum parâmetro de paginação for enviado, o proxy apenas repassa a resposta original
sem modificações.
